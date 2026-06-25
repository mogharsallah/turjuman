import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  CallToolResult,
  GetPromptResult,
  JSONRPCMessage,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { AppError, errorInfo, logError } from "@turjuman/core";
import {
  OPERATIONS,
  type OpContext,
  type Operation,
  effectiveAnnotations,
} from "@turjuman/sdk";
import pkg from "../package.json" with { type: "json" };
import { codemodeTools } from "./codemode.js";
import { PROMPTS, type PromptDef } from "./prompts/index.js";

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

/** Adapt one of our type-erased {@link Operation}s to an SDK tool callback. Tool
 * execution errors are surfaced as `isError` content (per MCP guidance) so the
 * agent can react, rather than as JSON-RPC protocol errors. */
function toolCallback(def: Operation, ctx: OpContext) {
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

/** Adapt one of our {@link PromptDef}s to an SDK prompt callback. The service
 * renders the messages; here we map them to MCP prompt-message blocks. Errors
 * surface as thrown (JSON-RPC) errors — an AppError keeps its code/message; an
 * unexpected fault is logged server-side and masked behind the request id, so
 * nothing internal leaks into the model context. */
function promptCallback(def: PromptDef, ctx: OpContext) {
  return async (args: Record<string, string | undefined>): Promise<GetPromptResult> => {
    try {
      const prompt = await def.handler(args, ctx);
      return {
        description: `Turjuman scoring prompt (${prompt.promptVersion})`,
        messages: prompt.messages.map((m) => ({
          role: m.role,
          content: { type: "text" as const, text: m.text },
        })),
      };
    } catch (e) {
      if (e instanceof AppError) throw new Error(`${e.code}: ${e.message}`);
      logError({ msg: "prompt_handler_error", requestId: ctx.requestId, prompt: def.name, error: errorInfo(e) });
      throw new Error(`Internal error (ref: ${ctx.requestId})`);
    }
  };
}

/** Behaviour hints for a tool, as MCP `ToolAnnotations`. The classification
 * (read-only / destructive / idempotent) is a property of the operation, so it
 * lives in `@turjuman/sdk` (`effectiveAnnotations`); here we only adapt the
 * SDK's transport-free `OpAnnotations` onto MCP's structurally-identical type. */
export function annotationsFor(def: Operation): ToolAnnotations {
  return effectiveAnnotations(def);
}

/** Build the static MCP registration config for one operation. */
function registrationFor(def: Operation) {
  return {
    def,
    config: {
      description: def.description,
      inputSchema: def.input,
      annotations: annotationsFor(def),
      ...(def.output ? { outputSchema: def.output } : {}),
    },
  };
}

/** The static registrations for each mode, assembled once at module scope. Only
 * the authenticated {@link OpContext} is injected per request (via the tool
 * callback), so this work is not repeated on every invocation.
 *  - classic: every business operation as its own tool;
 *  - code:    just `search_sdk` + `run_code` (the model writes code instead).
 * The two are mutually exclusive — a connection is in one mode or the other. */
const CLASSIC_REGISTRATIONS = OPERATIONS.map(registrationFor);
const CODEMODE_REGISTRATIONS = codemodeTools.map(registrationFor);

/** Which toolset to advertise for a request. Classic mode may be narrowed by a
 * client-requested allowlist (URL tool-scoping); code mode is the fixed pair. */
export type ToolSelection =
  | { mode: "classic"; allowed?: ReadonlySet<string> }
  | { mode: "code" };

const DEFAULT_SELECTION: ToolSelection = { mode: "classic" };

/** A fresh server per request so each tool callback closes over this request's
 * authenticated {@link OpContext}, keeping the server a pure, stateless
 * function. Registration reuses the module-scope registration configs, so only
 * the per-request callbacks are built here. The {@link ToolSelection} picks the
 * mode (classic toolset vs the code-mode pair); in classic mode an `allowed`
 * allowlist (client-requested URL tool-scoping) further narrows the toolset,
 * scoping both `tools/list` and `tools/call` from the one seam. This is a
 * presentation filter only; RBAC in core still authorizes every call. */
function buildServer(ctx: OpContext, selection: ToolSelection): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  const registrations =
    selection.mode === "code" ? CODEMODE_REGISTRATIONS : CLASSIC_REGISTRATIONS;
  const allowed = selection.mode === "classic" ? selection.allowed : undefined;
  for (const { def, config } of registrations) {
    if (allowed && !allowed.has(def.name)) continue;
    server.registerTool(def.name, config, toolCallback(def, ctx));
  }
  // Prompts are a separate capability from tools (the `?tools=`/`?groups=` filter
  // scopes tools only), so they register unconditionally — registering any one
  // makes the server advertise `prompts`.
  for (const def of PROMPTS) {
    server.registerPrompt(def.name, { description: def.description, argsSchema: def.argsSchema }, promptCallback(def, ctx));
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
  ctx: OpContext,
  selection: ToolSelection = DEFAULT_SELECTION,
): Promise<JsonRpcResponse | null> {
  const method = message.method;
  const id = message.id ?? null;
  if (!method) return err(id, -32600, "Invalid request: missing method");
  if (method.startsWith("notifications/") || id === null) return null;

  const server = buildServer(ctx, selection);
  const transport = new PumpTransport();
  await server.connect(transport);
  try {
    const response = await transport.exchange(message as JSONRPCMessage);
    return response as JsonRpcResponse;
  } finally {
    await server.close();
  }
}
