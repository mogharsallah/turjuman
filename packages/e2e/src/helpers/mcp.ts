import { request } from "./transport.js";

export class McpError extends Error {}

interface JsonRpcResult {
	result?: { content?: { text?: string }[]; isError?: boolean };
	error?: { code: number; message: string };
}

/**
 * List the tool names the server advertises at `url` through the real
 * `tools/list` path. `url` may carry a tool-scoping query string
 * (e.g. `?groups=read`), so this also exercises the transport's query parsing
 * end-to-end (Function URL in deployed mode, the handler in in-process mode).
 */
export async function mcpListTools(
	url: string,
	apiKey: string,
): Promise<string[]> {
	const res = await request(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
	if (!res.ok)
		throw new McpError(
			`MCP HTTP ${res.status} on tools/list: ${await res.text()}`,
		);
	const payload = (await res.json()) as {
		result?: { tools?: { name: string }[] };
	};
	return (payload.result?.tools ?? []).map((t) => t.name);
}

/**
 * Minimal MCP client over the transport seam. The server is stateless, so we
 * POST a single `tools/call` JSON-RPC message per call and parse the tool's text
 * content back into an object. `url` is the deployed MCP Function URL in deployed
 * mode, or the `mcp.inproc` sentinel in in-process mode.
 */
export function makeMcpClient(url: string, apiKey: string) {
	let id = 0;
	return async function call<T = unknown>(
		name: string,
		args: Record<string, unknown> = {},
	): Promise<T> {
		const res = await request(url, {
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
			throw new McpError(
				`MCP HTTP ${res.status} calling ${name}: ${await res.text()}`,
			);
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
 * A code-mode client over the MCP transport. Connects with `?mode=code` (where
 * the server advertises only `search` + `describe` + `run_code`), so calling
 * `runCode` exercises the full sandbox → bridge → core path end to end (over the
 * real Function URL in deployed mode, or the in-process handler otherwise).
 */
export function makeCodeClient(mcpUrl: string, apiKey: string) {
	const call = makeMcpClient(`${mcpUrl}?mode=code`, apiKey);
	return {
		runCode: <T = unknown>(code: string) =>
			call<SandboxRunResult<T>>("run_code", { code }),
		search: <T = unknown>(query?: string, limit?: number) =>
			call<T>(
				"search",
				limit !== undefined
					? { query, limit }
					: query !== undefined
						? { query }
						: {},
			),
		describe: <T = unknown>(id: string) => call<T>("describe", { id }),
	};
}

/**
 * A drop-in replacement for {@link makeMcpClient} that reaches operations through
 * the **code-mode** surface. The MCP advertises only `search`/`describe`/
 * `run_code` — there is no classic per-operation `tools/call` — so this runs a
 * one-line `return await turjuman.<op>(args)` in the sandbox, keeping the same
 * `(name, args) => result` shape the specs already use. An operation that throws
 * an AppError surfaces its `CODE: message` (e.g. `FORBIDDEN: …`) as the thrown
 * error, so RBAC/rejection assertions keep working; a rejected auth (a revoked
 * key) fails the underlying `run_code` POST with its HTTP status instead.
 */
export function makeOpClient(mcpUrl: string, apiKey: string) {
	const code = makeCodeClient(mcpUrl, apiKey);
	return async function call<T = unknown>(
		name: string,
		args: Record<string, unknown> = {},
	): Promise<T> {
		const res = await code.runCode<T>(
			`return await turjuman.${name}(${JSON.stringify(args)});`,
		);
		if (!res.ok) throw new McpError(res.error ?? `run_code failed: ${name}`);
		return res.result as T;
	};
}
