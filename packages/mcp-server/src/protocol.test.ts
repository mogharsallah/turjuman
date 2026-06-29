import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { OpContext } from "@turjuman/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMessage } from "./protocol.js";

/**
 * The MCP is a single **code surface**: it advertises exactly three tools —
 * `search`, `describe`, `run_code` — over the SDK registry, with no modes, no
 * per-key tool scoping, and no prompts. These tests cover the protocol envelope
 * (initialize / notifications / unknown methods) and that triple's behaviour.
 *
 * Operation-level arg mapping, input validation, pagination, and the error
 * masking *policy* are proven one layer down (`@turjuman/sdk`'s
 * `handlers.contract` and core's `maskError`); operations are reached through
 * `run_code`, never as their own `tools/call`, so this file only proves the
 * transport.
 */

// initialize / tools/list / ping do not touch the service, so a stub context is fine.
const ctx = {} as OpContext;

// A well-formed MCP initialize carries the client's capabilities and info; the
// SDK validates these, so include them (real clients always do).
const initParams = (protocolVersion: string) => ({
	protocolVersion,
	capabilities: {},
	clientInfo: { name: "test-client", version: "0.0.0" },
});

/** The fixed, only tool surface — a hand-authored oracle, not derived from code. */
const CODE_TOOLS = ["describe", "run_code", "search"];

describe("MCP protocol handler", () => {
	afterEach(() => vi.restoreAllMocks());

	it("responds to initialize with capabilities and negotiated version", async () => {
		const res = await handleMessage(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: initParams("2025-11-25"),
			},
			ctx,
		);
		expect(res).toMatchObject({
			id: 1,
			result: {
				protocolVersion: "2025-11-25",
				serverInfo: { name: "turjuman" },
			},
		});
	});

	it("falls back to the latest protocol for unknown versions", async () => {
		const res = (await handleMessage(
			{
				jsonrpc: "2.0",
				id: 2,
				method: "initialize",
				params: initParams("1999-01-01"),
			},
			ctx,
		)) as { result: { protocolVersion: string } };
		expect(res.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
	});

	it("reports the package version in serverInfo", async () => {
		const res = (await handleMessage(
			{
				jsonrpc: "2.0",
				id: 3,
				method: "initialize",
				params: initParams("2025-11-25"),
			},
			ctx,
		)) as { result: { serverInfo: { version: string } } };
		expect(res.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("advertises exactly the three code tools, each with an object input schema", async () => {
		const res = (await handleMessage(
			{ jsonrpc: "2.0", id: 4, method: "tools/list" },
			ctx,
		)) as {
			result: { tools: { name: string; inputSchema: { type: string } }[] };
		};
		const tools = res.result.tools;
		expect(tools.map((t) => t.name).sort()).toEqual(CODE_TOOLS);
		expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
	});

	it("search returns matching operations (with signatures) and docs", async () => {
		const res = (await handleMessage(
			{
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "search", arguments: { query: "translation" } },
			},
			ctx,
		)) as {
			result: {
				structuredContent?: {
					total: number;
					operations: { title: string; signature?: string }[];
					docs: unknown[];
				};
			};
		};
		const ops = res.result.structuredContent?.operations ?? [];
		expect(ops.length).toBeGreaterThan(0);
		expect(ops.map((o) => o.title)).toContain("bulk_set_translations");
		// Operations carry a typed signature, not just a name.
		expect(ops[0]?.signature).toBeTruthy();
	});

	it("describe surfaces an unknown id as a tool error (AppError code preserved)", async () => {
		// The masking boundary's AppError side: describe throws NOT_FOUND, and the
		// tool callback surfaces the code + message rather than masking it.
		const res = (await handleMessage(
			{
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: { name: "describe", arguments: { id: "op:does_not_exist" } },
			},
			ctx,
		)) as { result: { isError?: boolean; content: { text: string }[] } };
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0]?.text).toContain("NOT_FOUND");
	});

	it("run_code executes operations against the SDK through the sandbox", async () => {
		const list = vi.fn(async () => [{ id: "p1" }, { id: "p2" }]);
		const callCtx = {
			service: { projects: { list } },
			actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
			user: {},
			requestId: "req-test",
		} as unknown as OpContext;
		const res = (await handleMessage(
			{
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: {
					name: "run_code",
					arguments: {
						code: "const ps = await turjuman.list_projects({}); return ps.length;",
					},
				},
			},
			callCtx,
		)) as {
			result: {
				structuredContent?: { ok: boolean; result: unknown; opsUsed: number };
			};
		};
		expect(res.result.structuredContent?.ok).toBe(true);
		expect(res.result.structuredContent?.result).toBe(2);
		expect(res.result.structuredContent?.opsUsed).toBe(1);
		expect(list).toHaveBeenCalledWith(callCtx.actor);
	});

	it("returns null for notifications", async () => {
		expect(
			await handleMessage(
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				ctx,
			),
		).toBeNull();
	});

	it("rejects unknown methods", async () => {
		const res = await handleMessage(
			{ jsonrpc: "2.0", id: 8, method: "bogus" },
			ctx,
		);
		expect(res).toMatchObject({ id: 8, error: { code: -32601 } });
	});

	it("reports an unknown tool as an isError result", async () => {
		// Per MCP guidance the SDK surfaces tool-resolution failures as isError
		// content (so an agent can react), not as a JSON-RPC protocol error. An
		// operation name (e.g. list_projects) is "unknown" here — it is reached
		// through run_code, not as its own tool.
		const res = (await handleMessage(
			{
				jsonrpc: "2.0",
				id: 9,
				method: "tools/call",
				params: { name: "list_projects", arguments: {} },
			},
			ctx,
		)) as {
			id: number;
			result: { isError?: boolean; content: { text: string }[] };
		};
		expect(res.id).toBe(9);
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0]?.text).toContain("list_projects");
	});
});
