import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client.js";
import { CliError } from "./errors.js";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

describe("ApiClient.request", () => {
	it("builds the URL (handling a missing trailing slash), sets the Bearer header, and parses JSON", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ projects: [] }));
		const api = new ApiClient(
			"https://api.example.com",
			"op_live_x",
			fetchImpl as unknown as typeof fetch,
		);
		await api.listProjects();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(String(url)).toBe("https://api.example.com/v1/projects");
		expect((init as RequestInit).headers).toMatchObject({
			authorization: "Bearer op_live_x",
		});
		// GET has no body, so no content-type is set.
		expect((init as RequestInit).headers).not.toHaveProperty("content-type");
	});

	it("adds query params", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ entries: [] }));
		const api = new ApiClient(
			"https://api.example.com/",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		await api.exportBundle("proj_1", "es-MX", {
			working: true,
			excludeStale: true,
		});
		const [url] = fetchImpl.mock.calls[0]!;
		const parsed = new URL(String(url));
		expect(parsed.pathname).toBe("/v1/projects/proj_1/bundle");
		expect(parsed.searchParams.get("locale")).toBe("es-MX");
		expect(parsed.searchParams.get("slot")).toBe("working");
		expect(parsed.searchParams.get("excludeStale")).toBe("1");
	});

	it("throws an API error (exit 3) with the server's error message on non-OK", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ error: "nope" }, { status: 403 }),
		);
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		await expect(api.listProjects()).rejects.toMatchObject({
			message: "nope",
			exitCode: 3,
		});
	});

	it("throws an API error when the transport fails", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		await expect(api.listProjects()).rejects.toBeInstanceOf(CliError);
	});

	it("surfaces the error code and requestId from the body", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(
				{ error: "Internal error", code: "INTERNAL", requestId: "req-123" },
				{ status: 500 },
			),
		);
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		await expect(api.listProjects()).rejects.toMatchObject({
			message: "Internal error (request req-123)",
			code: "INTERNAL",
			requestId: "req-123",
			exitCode: 3,
		});
	});

	it("falls back to the X-Request-Id header when the body omits requestId", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "nope", code: "FORBIDDEN" }), {
					status: 403,
					headers: {
						"content-type": "application/json",
						"x-request-id": "hdr-9",
					},
				}),
		);
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		await expect(api.listProjects()).rejects.toMatchObject({
			message: "nope (request hdr-9)",
			requestId: "hdr-9",
		});
	});
});

describe("ApiClient pagination", () => {
	it("walks every page via nextCursor and aggregates, sending limit each time", async () => {
		const pages = [
			{ entries: [{ key: "a" }, { key: "b" }], nextCursor: "c1" },
			{ entries: [{ key: "c" }], nextCursor: null },
		];
		let call = 0;
		const fetchImpl = vi.fn(async () => jsonResponse(pages[call++]!));
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);

		const { entries } = await api.exportBundle("proj_1", "fr");

		expect(entries.map((e) => e.key)).toEqual(["a", "b", "c"]);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const first = new URL(String(fetchImpl.mock.calls[0]![0]));
		const second = new URL(String(fetchImpl.mock.calls[1]![0]));
		expect(first.searchParams.get("limit")).toBe("500");
		expect(first.searchParams.has("cursor")).toBe(false);
		expect(second.searchParams.get("cursor")).toBe("c1");
	});

	it("listKeys follows pagination too", async () => {
		const pages = [
			{ keys: [{ name: "a" }], nextCursor: "k1" },
			{ keys: [{ name: "b" }], nextCursor: undefined },
		];
		let call = 0;
		const fetchImpl = vi.fn(async () => jsonResponse(pages[call++]!));
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		const { keys } = await api.listKeys("proj_1", "default");
		expect(keys.map((k) => k.name)).toEqual(["a", "b"]);
		expect(
			new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get(
				"namespace",
			),
		).toBe("default");
	});
});

describe("ApiClient request-body validation", () => {
	it("rejects an invalid locale before sending (usage error, exit 2)", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ written: 0, skipped: [] }),
		);
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		await expect(
			api.importTranslations("proj_1", "NOT A LOCALE", [
				{ name: "k", value: "v" },
			]),
		).rejects.toMatchObject({ exitCode: 2 });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sends a validated keys-import body", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				created: 1,
				updated: 0,
				reactivated: 0,
				baseValuesSet: 1,
				deleted: 0,
				deprecated: 0,
			}),
		);
		const api = new ApiClient(
			"https://api.example.com",
			"k",
			fetchImpl as unknown as typeof fetch,
		);
		await api.importKeys(
			"proj_1",
			[{ name: "greeting", baseValue: "Hi" }],
			"default",
			{ deprecate: true },
		);
		const [, init] = fetchImpl.mock.calls[0]!;
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			namespace: "default",
			entries: [{ name: "greeting", baseValue: "Hi" }],
			deprecate: true,
		});
	});
});
