import { randomUUID } from "node:crypto";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import {
  TurjumanService,
  Repository,
  authenticate,
  decodeBody,
  errorInfo,
  logError,
  logInfo,
  lowerHeaderKeys,
  parseBearer,
  repositoryFromEnv,
  unauthorized,
} from "@turjuman/core";
import { handleMessage } from "./protocol.js";
import { allowedToolsForActor, resolveToolScope } from "./scope.js";
import type { ToolContext } from "./tools/index.js";

/**
 * AWS Lambda entry point for the Turjuman MCP server. Works behind both an API
 * Gateway HTTP API and a Lambda Function URL (both deliver lowercased headers
 * and a string/base64 body).
 */

// Reused across warm invocations.
const repo: Repository = repositoryFromEnv();
const service = new TurjumanService(repo);

// The methods the server actually answers (POST = JSON-RPC, GET = /health
// liveness, OPTIONS = CORS preflight). Advertised on the CORS preflight and in
// the `Allow` header of a 405.
const ALLOWED_METHODS = "GET, POST, OPTIONS";

/** CORS headers, built per call so the allowed origin can be locked down via
 * `TURJUMAN_ALLOWED_ORIGIN` (default `*`). DNS-rebinding is a low real risk for
 * a remote bearer-auth server, but an operator can still restrict it with zero
 * friction by default. */
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": process.env.TURJUMAN_ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  };
}

interface LambdaHttpEvent {
  requestContext?: { http?: { method?: string; path?: string } };
  httpMethod?: string;
  rawPath?: string;
  path?: string;
  // Function URL / API Gateway parse the query for us; `rawQueryString` is the
  // payload-format-2.0 fallback. Used for URL tool-scoping (?tools/?groups).
  queryStringParameters?: Record<string, string | undefined> | null;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

/** Normalise the request query into a plain object, preferring the platform's
 * parsed `queryStringParameters` and falling back to `rawQueryString`. */
function queryFromEvent(event: LambdaHttpEvent): Record<string, string | undefined> | undefined {
  if (event.queryStringParameters) return event.queryStringParameters;
  if (event.rawQueryString) return Object.fromEntries(new URLSearchParams(event.rawQueryString));
  return undefined;
}

interface LambdaContext {
  awsRequestId?: string;
}

interface LambdaHttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
}

export async function handler(
  event: LambdaHttpEvent,
  context?: LambdaContext,
): Promise<LambdaHttpResult> {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "POST";
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? "/";
  const headers = lowerHeaderKeys(event.headers ?? {});
  const body = decodeBody(event.body, event.isBase64Encoded);
  return processRequest({
    method,
    path,
    query: queryFromEvent(event),
    headers,
    body,
    service: { repo, service },
    // Tie our logs + the client-facing correlation id to Lambda's own request id.
    requestId: context?.awsRequestId,
  });
}

export interface ProcessDeps {
  repo: Repository;
  service: TurjumanService;
}

/** Transport-agnostic core, kept pure for testing. Emits exactly one structured
 * log line per request and stamps every response with its correlation id. */
export async function processRequest(args: {
  method: string;
  path?: string;
  query?: Record<string, string | undefined>;
  headers: Record<string, string>;
  body: string;
  service: ProcessDeps;
  requestId?: string;
}): Promise<LambdaHttpResult> {
  const { method, query, headers, body, service: deps } = args;
  const path = args.path ?? "/";
  const requestId = args.requestId ?? headers["x-request-id"] ?? randomUUID();
  const startedAt = Date.now();
  const meta: { method?: string; tool?: string; keyId?: string } = {};

  let result: LambdaHttpResult;
  let outcome: string;
  try {
    ({ result, outcome } = await route({ method, path, query, headers, body, deps, requestId, meta }));
  } catch (e) {
    // Safe failure: an unexpected throw (e.g. authenticate hitting a DynamoDB
    // outage) is logged server-side and answered with a generic internal error
    // referencing the correlation id — never a stack trace on the wire.
    logError({ msg: "mcp_unhandled", requestId, error: errorInfo(e) });
    outcome = "error";
    result = json(500, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: `Internal error (ref: ${requestId})` },
    });
  }

  // Surface the correlation id on every response so a client can quote it.
  result.headers = { ...result.headers, "x-request-id": requestId };
  logInfo({
    msg: "mcp_request",
    requestId,
    method: meta.method,
    tool: meta.tool,
    keyId: meta.keyId,
    outcome,
    status: result.statusCode,
    ms: Date.now() - startedAt,
  });
  return result;
}

/** The request routing, split out so {@link processRequest} owns the single
 * logging/correlation-id tail and a catch-all for unexpected throws. */
async function route(args: {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  headers: Record<string, string>;
  body: string;
  deps: ProcessDeps;
  requestId: string;
  meta: { method?: string; tool?: string; keyId?: string };
}): Promise<{ result: LambdaHttpResult; outcome: string }> {
  const { method, path, query, headers, body, deps, requestId, meta } = args;

  if (method === "OPTIONS") {
    return { result: { statusCode: 204, headers: corsHeaders() }, outcome: "preflight" };
  }
  // Unauthenticated liveness probe: lets a load balancer / uptime check confirm
  // the function is up without a JSON-RPC round-trip or an API key.
  if (method === "GET" && path === "/health") {
    return { result: json(200, { status: "ok" }), outcome: "health" };
  }
  if (method !== "POST") {
    // Stateless server: no server-initiated SSE stream, so a GET MCP stream (and
    // any other verb) is not allowed. Advertise what is, per RFC 7231.
    const result = json(405, { error: "Method Not Allowed" });
    result.headers = { ...result.headers, Allow: ALLOWED_METHODS };
    return { result, outcome: "method_not_allowed" };
  }

  // Per the MCP HTTP spec a present-but-unsupported `MCP-Protocol-Version` MUST be
  // rejected with 400; an absent header means assume "2025-03-26" (the SDK's
  // DEFAULT_NEGOTIATED_PROTOCOL_VERSION, a supported value), so we only reject
  // when the header is sent and unrecognised.
  const protocolVersion = headers["mcp-protocol-version"];
  if (protocolVersion !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return {
      result: json(400, { error: `Unsupported MCP-Protocol-Version: ${protocolVersion}` }),
      outcome: "unsupported_protocol_version",
    };
  }

  const token = parseBearer(headers["authorization"]);
  const auth = await authenticate(deps.repo, token);
  if (!auth) return { result: unauthorized(corsHeaders()), outcome: "unauthorized" };
  meta.keyId = auth.keyId;

  // Scope the advertised toolset. Two layers, both narrowing only:
  //  1. the key's own permissions (a read-only key sees read tools; tools the
  //     global role can never reach are hidden) — always applied;
  //  2. an optional client request via ?tools=/?groups= query params (a typo
  //     fails loud with 400 so it can't silently hide tools).
  // Core RBAC still authorizes every call; this only trims what is shown.
  const scope = resolveToolScope(query);
  if (scope && "error" in scope) {
    await auth.touch;
    return { result: json(400, { error: scope.error }), outcome: "invalid_tool_scope" };
  }
  const actorAllowed = allowedToolsForActor(auth.actor);
  const allowed = scope
    ? new Set([...scope.allowed].filter((name) => actorAllowed.has(name)))
    : actorAllowed;

  let message: unknown;
  try {
    message = JSON.parse(body || "{}");
  } catch {
    await auth.touch;
    return { result: rpc(-32700, "Parse error"), outcome: "parse_error" };
  }
  if (Array.isArray(message)) {
    await auth.touch;
    return { result: rpc(-32600, "JSON-RPC batching is not supported"), outcome: "bad_request" };
  }

  const msg = (message ?? {}) as { method?: unknown; params?: { name?: unknown } };
  if (typeof msg.method === "string") meta.method = msg.method;
  if (meta.method === "tools/call" && typeof msg.params?.name === "string") {
    meta.tool = msg.params.name;
  }

  const ctx: ToolContext = { service: deps.service, actor: auth.actor, user: auth.user, requestId };
  const response = await handleMessage(message as Record<string, unknown>, ctx, allowed);

  // Flush the best-effort last-used stamp before returning: it started during
  // authenticate() and has overlapped the work above, so this await costs ~0 but
  // guarantees the write isn't dropped when Lambda freezes the event loop.
  await auth.touch;

  if (response === null) {
    return { result: { statusCode: 202, headers: corsHeaders() }, outcome: "accepted" };
  }
  return { result: json(200, response), outcome: outcomeFor(response) };
}

/** Classify a JSON-RPC response for the request log. A protocol-level `error`
 * and a tool-level `isError` result are distinct signals worth querying apart. */
function outcomeFor(response: Record<string, unknown>): string {
  if (response.error) return "rpc_error";
  const result = response.result as { isError?: boolean } | undefined;
  if (result?.isError) return "tool_error";
  return "ok";
}

function json(statusCode: number, payload: unknown): LambdaHttpResult {
  return {
    statusCode,
    headers: { ...corsHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function rpc(code: number, message: string): LambdaHttpResult {
  return json(200, { jsonrpc: "2.0", id: null, error: { code, message } });
}
