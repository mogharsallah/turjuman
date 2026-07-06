import {
	hashApiKey,
	type Repository,
	type TurjumanService,
} from "@turjuman/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProcessDeps, processRequest } from "./handler.js";

/**
 * Hermetic tests for the MCP HTTP layer (handler.ts): authentication, the
 * structured per-request log line, the correlation-id header, and the
 * best-effort-but-flushed last-used stamp. The transport only touches
 * `deps.repo` to authenticate, so a tiny fake exercises the full path without
 * DynamoDB.
 */

const SECRET = "test-secret";
const user = { id: "user_1", orgId: "default", globalRole: "OWNER" as const };

/** A repo that authenticates exactly one bearer secret. `touchApiKey` resolves
 * on a later tick and flips `touched` so a test can prove it was flushed. */
function fakeRepo(state: { touched: boolean }): Repository {
	return {
		getApiKeyByHash: async (hash: string) =>
			hash === hashApiKey(SECRET)
				? {
						id: "key_1",
						orgId: "default",
						userId: user.id,
						name: "t",
						hash,
						prefix: "op_live_t",
						createdAt: "now",
					}
				: undefined,
		getUser: async (id: string) =>
			id === user.id
				? {
						...user,
						email: "t@t.com",
						name: "T",
						createdAt: "now",
						updatedAt: "now",
					}
				: undefined,
		touchApiKey: async () => {
			await new Promise((r) => setTimeout(r, 5));
			state.touched = true;
		},
	} as unknown as Repository;
}

function deps(state: { touched: boolean }): ProcessDeps {
	return { repo: fakeRepo(state), service: {} as TurjumanService };
}

const lastLog = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> =>
	JSON.parse(spy.mock.calls.at(-1)?.[0] as string);

describe("MCP handler — processRequest", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("authenticates, answers, and logs one structured line with a correlation id", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const state = { touched: false };
		const res = await processRequest({
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			service: deps(state),
		});

		expect(res.statusCode).toBe(200);
		expect(res.headers["x-request-id"]).toBeTruthy();

		const line = lastLog(logSpy);
		expect(line).toMatchObject({
			msg: "mcp_request",
			method: "tools/list",
			keyId: "key_1",
			outcome: "ok",
		});
		expect(line.requestId).toBe(res.headers["x-request-id"]);
		expect(typeof line.ms).toBe("number");
	});

	it("flushes the best-effort last-used stamp before returning", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const state = { touched: false };
		await processRequest({
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			service: deps(state),
		});
		// touchApiKey resolves on a later tick; if it were fire-and-forget this would
		// still be false when processRequest resolved.
		expect(state.touched).toBe(true);
	});

	it("records the tool name on a tools/call", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const state = { touched: false };
		await processRequest({
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "search", arguments: { query: "keys" } },
			}),
			service: deps(state),
		});
		expect(lastLog(logSpy)).toMatchObject({
			method: "tools/call",
			tool: "search",
			outcome: "ok",
		});
	});

	it("rejects a bad key as unauthorized and still logs + stamps the response", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "POST",
			headers: { authorization: "Bearer wrong" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			service: deps({ touched: false }),
		});
		expect(res.statusCode).toBe(401);
		expect(res.headers["x-request-id"]).toBeTruthy();
		expect(lastLog(logSpy)).toMatchObject({
			outcome: "unauthorized",
			status: 401,
		});
	});

	it("honours an inbound x-request-id as the correlation id", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "POST",
			headers: {
				authorization: `Bearer ${SECRET}`,
				"x-request-id": "trace-xyz",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			service: deps({ touched: false }),
		});
		expect(res.headers["x-request-id"]).toBe("trace-xyz");
	});

	it("answers GET /health with 200 and needs no API key", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "GET",
			path: "/health",
			headers: {},
			body: "",
			service: deps({ touched: false }),
		});
		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body ?? "{}")).toMatchObject({ status: "ok" });
		expect(lastLog(logSpy)).toMatchObject({ outcome: "health" });
	});

	it("rejects an unsupported verb with 405 and an Allow header", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "DELETE",
			headers: {},
			body: "",
			service: deps({ touched: false }),
		});
		expect(res.statusCode).toBe(405);
		expect(res.headers.Allow).toContain("POST");
	});

	it("rejects a present-but-unsupported MCP-Protocol-Version with 400", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "POST",
			headers: {
				authorization: `Bearer ${SECRET}`,
				"mcp-protocol-version": "1999-01-01",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			service: deps({ touched: false }),
		});
		expect(res.statusCode).toBe(400);
		expect(lastLog(logSpy)).toMatchObject({
			outcome: "unsupported_protocol_version",
			status: 400,
		});
	});

	it("accepts a supported MCP-Protocol-Version header", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "POST",
			headers: {
				authorization: `Bearer ${SECRET}`,
				"mcp-protocol-version": "2025-11-25",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			service: deps({ touched: false }),
		});
		expect(res.statusCode).toBe(200);
	});

	it("advertises exactly the three code tools (no modes, no scoping)", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "POST",
			headers: { authorization: `Bearer ${SECRET}` },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			service: deps({ touched: false }),
		});
		const names = (
			JSON.parse(res.body ?? "{}").result.tools as { name: string }[]
		).map((t) => t.name);
		expect(names.sort()).toEqual(["describe", "run_code", "search"]);
	});

	it("honours TURJUMAN_ALLOWED_ORIGIN for the CORS origin", async () => {
		vi.stubEnv("TURJUMAN_ALLOWED_ORIGIN", "https://app.example.com");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const res = await processRequest({
			method: "GET",
			path: "/health",
			headers: {},
			body: "",
			service: deps({ touched: false }),
		});
		expect(res.headers["Access-Control-Allow-Origin"]).toBe(
			"https://app.example.com",
		);
	});
});
