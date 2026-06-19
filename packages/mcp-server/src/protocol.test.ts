import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { notFound } from "@turjuman/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMessage } from "./protocol.js";
import type { ToolContext } from "./tools/index.js";

// initialize/tools/list/ping do not touch the service, so a stub context is fine.
const ctx = {} as ToolContext;

// A well-formed MCP initialize carries the client's capabilities and info; the
// SDK validates these, so include them (real clients always do).
const initParams = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: {},
  clientInfo: { name: "test-client", version: "0.0.0" },
});

describe("MCP protocol handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("responds to initialize with capabilities and negotiated version", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: initParams("2025-11-25") },
      ctx,
    );
    expect(res).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-11-25", serverInfo: { name: "turjuman" } },
    });
  });

  it("falls back to the latest protocol for unknown versions", async () => {
    const res = (await handleMessage(
      { jsonrpc: "2.0", id: 2, method: "initialize", params: initParams("1999-01-01") },
      ctx,
    )) as { result: { protocolVersion: string } };
    expect(res.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("lists tools with JSON Schemas", async () => {
    const res = (await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, ctx)) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain("create_project");
    expect(names).toContain("bulk_set_translations");
    expect(names).toContain("add_member");
    expect(names).toContain("revoke_api_key");
    expect(res.result.tools.every((t) => t.inputSchema.type === "object")).toBe(true);
  });

  it("annotates tools with read-only / destructive hints", async () => {
    const res = (await handleMessage({ jsonrpc: "2.0", id: 30, method: "tools/list" }, ctx)) as {
      result: { tools: { name: string; annotations?: Record<string, boolean>; outputSchema?: { type: string } }[] };
    };
    const by = new Map(res.result.tools.map((t) => [t.name, t]));
    expect(by.get("list_projects")?.annotations?.readOnlyHint).toBe(true);
    expect(by.get("run_qa_checks")?.annotations?.readOnlyHint).toBe(true);
    expect(by.get("delete_project")?.annotations?.destructiveHint).toBe(true);
    expect(by.get("delete_key")?.annotations?.destructiveHint).toBe(true);
    expect(by.get("revoke_api_key")?.annotations?.destructiveHint).toBe(true);
    // A non-destructive write is flagged read-write but not destructive.
    expect(by.get("create_key")?.annotations?.readOnlyHint).toBe(false);
    expect(by.get("create_key")?.annotations?.destructiveHint).toBe(false);
    // outputSchema is declared (incrementally) on the tools a client parses.
    expect(by.get("get_key")?.outputSchema?.type).toBe("object");
    expect(by.get("list_untranslated")?.outputSchema?.type).toBe("object");
  });

  it("reports the package version in serverInfo", async () => {
    const res = (await handleMessage(
      { jsonrpc: "2.0", id: 31, method: "initialize", params: initParams("2025-11-25") },
      ctx,
    )) as { result: { serverInfo: { version: string } } };
    expect(res.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("emits structuredContent for an object-returning tool", async () => {
    // A complete project so it validates against get_project's outputSchema
    // (projectSchema) — the SDK drops structuredContent that fails validation.
    const project = {
      id: "proj_1",
      orgId: "o",
      name: "Demo",
      slug: "demo",
      baseLocale: "en",
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const callCtx = {
      service: { projects: { get: async () => project } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
    } as unknown as ToolContext;
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "get_project", arguments: { projectId: "proj_1" } },
      },
      callCtx,
    )) as { result: { structuredContent?: unknown; content: { text: string }[] } };
    expect(res.result.structuredContent).toEqual(project);
    expect(res.result.content[0]?.text).toContain("proj_1");
  });

  it("omits structuredContent for an array-returning tool", async () => {
    const callCtx = {
      service: { projects: { list: async () => [{ id: "proj_1" }] } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
    } as unknown as ToolContext;
    const res = (await handleMessage(
      { jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "list_projects", arguments: {} } },
      callCtx,
    )) as { result: { structuredContent?: unknown; content: { text: string }[] } };
    expect(res.result.structuredContent).toBeUndefined();
    expect(res.result.content[0]?.text).toContain("proj_1");
  });

  it("masks a non-AppError tool failure behind the correlation id", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callCtx = {
      service: { projects: { get: async () => { throw new Error("DynamoDB exploded"); } } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
      requestId: "req-test",
    } as unknown as ToolContext;
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: { name: "get_project", arguments: { projectId: "proj_1" } },
      },
      callCtx,
    )) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    const text = res.result.content[0]?.text ?? "";
    expect(text).toContain("Internal error (ref: req-test)");
    // The raw internal error never reaches the model context...
    expect(text).not.toContain("DynamoDB exploded");
    // ...but it is logged server-side for the operator.
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0]?.[0]).toContain("DynamoDB exploded");
  });

  it("still surfaces an AppError's code and message to the agent", async () => {
    const callCtx = {
      service: { projects: { get: async () => { throw notFound("no such project"); } } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
      requestId: "req-test",
    } as unknown as ToolContext;
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: { name: "get_project", arguments: { projectId: "proj_1" } },
      },
      callCtx,
    )) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]?.text).toContain("NOT_FOUND: no such project");
  });

  it("scopes tools/list to the requested allowlist", async () => {
    const allowed = new Set(["get_key", "list_keys"]);
    const res = (await handleMessage({ jsonrpc: "2.0", id: 50, method: "tools/list" }, ctx, allowed)) as {
      result: { tools: { name: string }[] };
    };
    const names = res.result.tools.map((t) => t.name);
    expect(names.sort()).toEqual(["get_key", "list_keys"]);
  });

  it("reports an out-of-scope tool as not found (cannot be called)", async () => {
    // An allowlist that excludes delete_key means the SDK never registers it, so
    // a tools/call resolves to the same not-found isError as an unknown tool —
    // scoping covers both tools/list and tools/call from one seam.
    const del = vi.fn();
    const callCtx = {
      service: { keys: { delete: del } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
      requestId: "req-test",
    } as unknown as ToolContext;
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: { name: "delete_key", arguments: { projectId: "p", name: "k", confirm: true } },
      },
      callCtx,
      new Set(["get_key"]),
    )) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]?.text).toContain("delete_key");
    expect(del).not.toHaveBeenCalled();
  });

  it("returns null for notifications", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).toBeNull();
  });

  it("rejects unknown methods", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 4, method: "bogus" }, ctx);
    expect(res).toMatchObject({ id: 4, error: { code: -32601 } });
  });

  it("reports an unknown tool as an isError result", async () => {
    // Per MCP guidance the SDK surfaces tool-resolution failures as isError
    // content (so an agent can react), not as a JSON-RPC protocol error.
    const res = (await handleMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
      ctx,
    )) as { id: number; result: { isError?: boolean; content: { text: string }[] } };
    expect(res.id).toBe(5);
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]?.text).toContain("nope");
  });

  it("rejects a bulk_set_translations payload over the entries cap before the service runs", async () => {
    // The .max(500) input bound is enforced by the SDK's schema validation, so an
    // oversized batch is refused without ever reaching the service.
    const bulkSet = vi.fn();
    const callCtx = {
      service: { translations: { bulkSet } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
      requestId: "req-test",
    } as unknown as ToolContext;
    const entries = Array.from({ length: 501 }, (_, i) => ({ name: `k${i}`, value: "v" }));
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "bulk_set_translations", arguments: { projectId: "proj_1", locale: "fr", entries } },
      },
      callCtx,
    )) as { result?: { isError?: boolean }; error?: { code: number } };
    // The SDK rejects invalid params (either as an isError result or a protocol error)...
    expect(res.error !== undefined || res.result?.isError === true).toBe(true);
    // ...and the handler never invoked the service.
    expect(bulkSet).not.toHaveBeenCalled();
  });

  it("requires confirm before delete_key reaches the service", async () => {
    // delete_key declares a required `confirm` boolean; omitting it is invalid
    // params, so the destructive cascade never runs.
    const del = vi.fn();
    const callCtx = {
      service: { keys: { delete: del } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
      requestId: "req-test",
    } as unknown as ToolContext;
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "delete_key", arguments: { projectId: "proj_1", name: "greeting" } },
      },
      callCtx,
    )) as { result?: { isError?: boolean }; error?: { code: number } };
    expect(res.error !== undefined || res.result?.isError === true).toBe(true);
    expect(del).not.toHaveBeenCalled();
  });

  it("threads a pagination cursor through a paged growth tool", async () => {
    // get_translations(locale) is paged: the tool forwards limit/cursor to the
    // service page method and returns its { translations, nextCursor }.
    const listForLocalePage = vi.fn(async () => ({
      translations: [{ keyName: "k1", localeCode: "fr", value: "v" }],
      nextCursor: "next-1",
    }));
    const callCtx = {
      service: { translations: { listForLocalePage } },
      actor: { userId: "u", orgId: "o", globalRole: "OWNER", readOnly: false },
      user: {},
      requestId: "req-test",
    } as unknown as ToolContext;
    const res = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "get_translations", arguments: { projectId: "proj_1", locale: "fr", cursor: "c0" } },
      },
      callCtx,
    )) as { result: { structuredContent?: { nextCursor?: string } } };
    // The cursor was passed through and the default page size applied.
    expect(listForLocalePage).toHaveBeenCalledWith(expect.anything(), "proj_1", "fr", {
      limit: 100,
      cursor: "c0",
    });
    expect(res.result.structuredContent?.nextCursor).toBe("next-1");
  });
});
