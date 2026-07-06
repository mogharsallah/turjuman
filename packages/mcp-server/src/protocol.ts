import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
	CallToolResult,
	JSONRPCMessage,
	ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { maskError } from "@turjuman/core";
import {
	effectiveAnnotations,
	type OpContext,
	type Operation,
} from "@turjuman/sdk";
import pkg from "../package.json" with { type: "json" };
import { codemodeTools } from "./codemode.js";

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
	"Turjuman translation management over a code-first MCP. Discover capabilities with " +
	"search(query), get full schemas with describe(id), then call operations from run_code " +
	"as `await turjuman.<operation>(args)`. Start with search to find what you need.";

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

type JsonRpcResponse =
	| { jsonrpc: "2.0"; id: string | number | null; result: unknown }
	| {
			jsonrpc: "2.0";
			id: string | number | null;
			error: { code: number; message: string };
	  };

function err(
	id: string | number | null,
	code: number,
	message: string,
): JsonRpcResponse {
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
			const result: CallToolResult = {
				content: [{ type: "text", text: toText(data) }],
			};
			const structured = asStructured(data);
			if (structured) result.structuredContent = structured;
			return result;
		} catch (e) {
			// One masking policy across every boundary (core's `maskError`): an
			// AppError is intentional and model-actionable, so surface its code +
			// message; anything else is logged server-side and replaced with a generic
			// message + correlation id, so nothing internal leaks into model context.
			const masked = maskError(e, {
				msg: "tool_handler_error",
				requestId: ctx.requestId,
				tool: def.name,
			});
			const text = masked.isAppError
				? `Error: ${masked.code}: ${masked.message}`
				: `Error: ${masked.message}`;
			return { content: [{ type: "text", text }], isError: true };
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

/** The static tool registrations, assembled once at module scope: `search` +
 * `describe` + `run_code` (the model writes code instead of calling a tool per
 * operation). Only the authenticated {@link OpContext} is injected per request
 * (via the tool callback), so this work is not repeated on every invocation. */
const CODEMODE_REGISTRATIONS = codemodeTools.map(registrationFor);

/** A fresh server per request so each tool callback closes over this request's
 * authenticated {@link OpContext}, keeping the server a pure, stateless
 * function. Registration reuses the module-scope registration configs, so only
 * the per-request callbacks are built here. The surface is the fixed code-mode
 * triple; RBAC in core still authorizes every call the sandbox dispatches. */
function buildServer(ctx: OpContext): McpServer {
	const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
	for (const { def, config } of CODEMODE_REGISTRATIONS) {
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
	ctx: OpContext,
): Promise<JsonRpcResponse | null> {
	const method = message.method;
	const id = message.id ?? null;
	if (!method) return err(id, -32600, "Invalid request: missing method");
	if (method.startsWith("notifications/") || id === null) return null;

	const server = buildServer(ctx);
	const transport = new PumpTransport();
	await server.connect(transport);
	try {
		const response = await transport.exchange(message as JSONRPCMessage);
		return response as JsonRpcResponse;
	} finally {
		await server.close();
	}
}
