export class McpError extends Error {}

interface JsonRpcResult {
  result?: { content?: { text?: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

/**
 * List the tool names the server advertises at `url` through the real
 * `tools/list` path. `url` may carry a tool-scoping query string
 * (e.g. `?groups=read`), so this also exercises the Function URL's query
 * parsing end-to-end.
 */
export async function mcpListTools(url: string, apiKey: string): Promise<string[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (!res.ok) throw new McpError(`MCP HTTP ${res.status} on tools/list: ${await res.text()}`);
  const payload = (await res.json()) as { result?: { tools?: { name: string }[] } };
  return (payload.result?.tools ?? []).map((t) => t.name);
}

/**
 * Minimal MCP-over-HTTP client for the deployed MCP Function URL. The server is
 * stateless, so we POST a single `tools/call` JSON-RPC message per call and
 * parse the tool's text content back into an object.
 */
export function makeMcpClient(url: string, apiKey: string) {
  let id = 0;
  return async function call<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (!res.ok) {
      throw new McpError(`MCP HTTP ${res.status} calling ${name}: ${await res.text()}`);
    }
    const payload = (await res.json()) as JsonRpcResult;
    if (payload.error) {
      throw new McpError(`MCP error calling ${name}: ${payload.error.message}`);
    }
    const text = payload.result?.content?.[0]?.text ?? "";
    if (payload.result?.isError) {
      throw new McpError(`Tool ${name} returned an error: ${text}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  };
}

/** The structured result the `run_code` tool returns (mirrors `RunResult`). */
export interface SandboxRunResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  logs: { level: string; message: string }[];
  opsUsed: number;
  truncated: boolean;
}

/**
 * A code-mode client for the deployed MCP Function URL. Connects with
 * `?mode=code` (where the server advertises only `search_sdk` + `run_code`),
 * so calling `runCode` exercises the full sandbox → bridge → core path end to
 * end over the real Function URL.
 */
export function makeCodeClient(mcpUrl: string, apiKey: string) {
  const call = makeMcpClient(`${mcpUrl}?mode=code`, apiKey);
  return {
    runCode: <T = unknown>(code: string) => call<SandboxRunResult<T>>("run_code", { code }),
    searchSdk: <T = unknown>(query?: string, limit?: number) =>
      call<T>("search_sdk", limit !== undefined ? { query, limit } : query !== undefined ? { query } : {}),
  };
}
