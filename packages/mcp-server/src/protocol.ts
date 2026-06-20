import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  JSONRPCMessage,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { AppError, errorInfo, logError } from "@turjuman/core";
import pkg from "../package.json" with { type: "json" };
import { TOOLS, type ToolContext, type ToolDef } from "./tools/index.js";

/**
 * Stateless MCP over Streamable HTTP, backed by the official SDK.
 *
 * Each HTTP POST carries exactly one JSON-RPC message. We drive the SDK's
 * `McpServer` (which owns version negotiation, capability advertisement,
 * JSON-RPC framing, `tools/list` schema generation and `tools/call` argument
 * validation) through an in-memory "pump" transport that delivers that one
 * message and captures the single response — keeping the server a pure
 * function with no session storage, which is what a stateless Lambda needs.
 *
 * `handleMessage` is the thin facade the HTTP layer (handler.ts) and the unit
 * tests call: one message in, one response out (or `null` for notifications).
 */

const SERVER_INFO = { name: "turjuman", version: pkg.version };

const INSTRUCTIONS =
  "Turjuman translation management. Use list_projects to start. To translate: " +
  "list_untranslated(locale) -> translate the values yourself -> bulk_set_translations. " +
  "Always write a clear description on create_key so future translations have context.";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toText(data: unknown): string {
  if (data === undefined || data === null) return "ok";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

/** Object (non-array) results are also emitted as MCP `structuredContent`, which
 * a governed-AI client can parse directly. The JSON-in-text block is always sent
 * too, for clients that only read text. Arrays and scalars carry text only
 * (structured content must be a JSON object per the MCP spec). */
function asStructured(data: unknown): Record<string, unknown> | undefined {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
}

/** Adapt one of our type-erased {@link ToolDef}s to an SDK tool callback. Tool
 * execution errors are surfaced as `isError` content (per MCP guidance) so the
 * agent can react, rather than as JSON-RPC protocol errors. */
function toolCallback(def: ToolDef, ctx: ToolContext) {
  return async (args: unknown): Promise<CallToolResult> => {
    try {
      const data = await def.handler(args, ctx);
      const result: CallToolResult = { content: [{ type: "text", text: toText(data) }] };
      const structured = asStructured(data);
      if (structured) result.structuredContent = structured;
      return result;
    } catch (e) {
      // AppErrors are intentional, model-actionable failures (bad input, a
      // permission denial) — surface their code + message so the agent can
      // adjust. Anything else (a raw DynamoDB/AWS SDK error) is an internal
      // fault: log it server-side and return a generic message plus the
      // correlation id, so nothing internal leaks into the model context.
      if (e instanceof AppError) {
        return { content: [{ type: "text", text: `Error: ${e.code}: ${e.message}` }], isError: true };
      }
      logError({
        msg: "tool_handler_error",
        requestId: ctx.requestId,
        tool: def.name,
        error: errorInfo(e),
      });
      return {
        content: [{ type: "text", text: `Error: Internal error (ref: ${ctx.requestId})` }],
        isError: true,
      };
    }
  };
}

/** Behaviour hints for a tool. An explicit `def.annotations` wins; otherwise we
 * derive them from the verb in the tool name — read tools are read-only, the
 * delete/revoke/remove family is destructive, and the rest are non-destructive
 * writes (set_/update_ are also idempotent). */
export function annotationsFor(def: ToolDef): ToolAnnotations {
  if (def.annotations) return def.annotations;
  const name = def.name;
  if (/^(list|get|search|lookup)_/.test(name)) return { readOnlyHint: true };
  if (/^(delete|revoke|remove)_/.test(name)) {
    return { readOnlyHint: false, destructiveHint: true };
  }
  return {
    readOnlyHint: false,
    destructiveHint: false,
    ...(/^(set|update)_/.test(name) ? { idempotentHint: true } : {}),
  };
}

/** The static SDK registration for every tool, assembled once at module scope.
 * Only the authenticated {@link ToolContext} is injected per request (via the
 * tool callback), so this work is not repeated on every invocation. */
const REGISTRATIONS = TOOLS.map((def) => ({
  def,
  config: {
    description: def.description,
    inputSchema: def.input,
    annotations: annotationsFor(def),
    ...(def.output ? { outputSchema: def.output } : {}),
  },
}));

/** A fresh server per request so each tool callback closes over this request's
 * authenticated {@link ToolContext}, keeping the server a pure, stateless
 * function. Registration reuses the module-scope {@link REGISTRATIONS} configs,
 * so only the per-request callbacks are built here. When `allowed` is given
 * (client-requested URL tool-scoping), only those tools are registered — which
 * scopes both `tools/list` and `tools/call` from the one seam. This is a
 * presentation filter only; RBAC in core still authorizes every call. */
function buildServer(ctx: ToolContext, allowed?: ReadonlySet<string>): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const { def, config } of REGISTRATIONS) {
    if (allowed && !allowed.has(def.name)) continue;
    server.registerTool(def.name, config, toolCallback(def, ctx));
  }
  return server;
}

/**
 * In-memory transport that delivers exactly one inbound message to the SDK
 * server and resolves with the one response the server sends back. Used once
 * per request and discarded.
 */
class PumpTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private settle?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.settle?.(message);
  }

  /** Deliver one request; resolves when the server replies (always, for a
   * request with an id — the SDK answers even unknown methods/tools). */
  exchange(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    return new Promise<JSONRPCMessage>((resolve) => {
      this.settle = resolve;
      this.onmessage?.(message);
    });
  }
}

/**
 * Handle one JSON-RPC message. Returns a response, or `null` for notifications
 * (the caller should reply HTTP 202 with no body). Requests without an `id` are
 * treated as notifications, per JSON-RPC.
 */
export async function handleMessage(
  message: JsonRpcMessage,
  ctx: ToolContext,
  allowed?: ReadonlySet<string>,
): Promise<JsonRpcResponse | null> {
  const method = message.method;
  const id = message.id ?? null;
  if (!method) return err(id, -32600, "Invalid request: missing method");
  if (method.startsWith("notifications/") || id === null) return null;

  const server = buildServer(ctx, allowed);
  const transport = new PumpTransport();
  await server.connect(transport);
  try {
    const response = await transport.exchange(message as JSONRPCMessage);
    return response as JsonRpcResponse;
  } finally {
    await server.close();
  }
}
