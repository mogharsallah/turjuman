import { forbidden, notFound } from "@turjuman/core";
import { describe, expect, it, vi } from "vitest";
import { appWith, auth, jsonHeaders } from "./transport.test-support.js";

/**
 * Hermetic HTTP-layer tests for the error, authz, validation and pagination
 * paths. The router only touches `deps.repo` to authenticate and `deps.service`
 * to do work, so a tiny fake of each (in `./transport.test-support.ts`, shared
 * with the other router suites) exercises the full request → response shape
 * without DynamoDB.
 */

describe("REST router — error, authz, validation & pagination", () => {
	it("maps a service FORBIDDEN to 403 with the typed envelope", async () => {
		const app = appWith({
			projects: {
				get: async () => {
					throw forbidden("nope");
				},
			},
		});
		const res = await app.request("/v1/projects/p1", auth);
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			code: "FORBIDDEN",
			error: "nope",
		});
	});

	it("maps a service NOT_FOUND to 404", async () => {
		const app = appWith({
			projects: {
				get: async () => {
					throw notFound("gone");
				},
			},
		});
		const res = await app.request("/v1/projects/p1", auth);
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
	});

	it("rejects an invalid request body with 400 before calling the service", async () => {
		const add = vi.fn();
		const app = appWith({ locales: { add } });
		// addLocaleBodySchema requires `code`; an empty body must fail validation.
		const res = await app.request("/v1/projects/p1/locales", {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION" });
		expect(add).not.toHaveBeenCalled();
	});

	it("never leaks an internal error message, returning a generic 500 + requestId", async () => {
		const app = appWith({
			projects: {
				list: async () => {
					throw new Error("secret stack detail");
				},
			},
		});
		const res = await app.request("/v1/projects", auth);
		expect(res.status).toBe(500);
		const body = (await res.json()) as {
			error: string;
			code: string;
			requestId: string;
		};
		expect(body).toMatchObject({ error: "Internal error", code: "INTERNAL" });
		expect(body.requestId).toBeTruthy();
		expect(JSON.stringify(body)).not.toContain("secret stack detail");
	});

	it("uses the paginated key path only when limit/cursor are present", async () => {
		const list = vi.fn(async () => [{ name: "a" }]);
		const listPage = vi.fn(async () => ({
			keys: [{ name: "a" }],
			nextCursor: "c2",
		}));
		const app = appWith({ keys: { list, listPage } });

		const plain = await app.request("/v1/projects/p1/keys", auth);
		expect(await plain.json()).toMatchObject({ keys: [{ name: "a" }] });
		expect(list).toHaveBeenCalledOnce();
		expect(listPage).not.toHaveBeenCalled();

		const paged = await app.request("/v1/projects/p1/keys?limit=2", auth);
		expect(await paged.json()).toMatchObject({ nextCursor: "c2" });
		expect(listPage).toHaveBeenCalledWith(
			expect.anything(),
			"p1",
			expect.objectContaining({ limit: 2 }),
		);
	});

	it("paginates translations via limit/cursor and passes the cursor through", async () => {
		const listForLocale = vi.fn(async () => [{ keyName: "a" }]);
		const listForLocalePage = vi.fn(async () => ({
			translations: [{ keyName: "a" }],
			nextCursor: "next",
		}));
		const app = appWith({ translations: { listForLocale, listForLocalePage } });

		const res = await app.request(
			"/v1/projects/p1/translations?locale=fr&cursor=x",
			auth,
		);
		expect(await res.json()).toMatchObject({
			locale: "fr",
			nextCursor: "next",
		});
		expect(listForLocalePage).toHaveBeenCalledWith(
			expect.anything(),
			"p1",
			"fr",
			expect.objectContaining({ cursor: "x" }),
		);
		expect(listForLocale).not.toHaveBeenCalled();
	});

	it("requires the locale query param on translations", async () => {
		const app = appWith({ translations: {} });
		const res = await app.request("/v1/projects/p1/translations", auth);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION" });
	});

	it("enforces the operation's OWN input schema on a projected route (no transport drift)", async () => {
		// set_qa_config's op input caps `ignore` at .max(500); the REST body schema
		// doesn't. The projection re-validates against op.input, so an over-cap array
		// is rejected with 400 before the service is touched — exactly as over MCP.
		const setConfig = vi.fn();
		const app = appWith({ qa: { setConfig } });
		const ignore = Array.from({ length: 501 }, () => ({ checkId: "icu" }));
		const res = await app.request("/v1/projects/p1/qa-config", {
			method: "PUT",
			headers: jsonHeaders,
			body: JSON.stringify({ ignore }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION" });
		expect(setConfig).not.toHaveBeenCalled();
	});
});
