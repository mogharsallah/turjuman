import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createApp } from "@turjuman/api/router";
import { Repository, TurjumanService } from "@turjuman/core";
import { processRequest } from "@turjuman/mcp-server";
import { type E2EEnv, loadEnv, modeOf } from "./env.js";

/**
 * The single HTTP seam the MCP/REST helpers go through. In `deployed` mode it is
 * plain `fetch` to the real Function URLs. In `inprocess` mode it routes the
 * sentinel hosts to the actual handlers — the MCP server's transport-agnostic
 * `processRequest` and the REST app via Hono's `app.request` — backed by the same
 * LocalStack DynamoDB table the global setup provisioned. So the specs exercise
 * the real transport projection (JSON-RPC routing, tool scoping, code mode, the
 * REST router, auth + RBAC) + core + DynamoDB, with no CDK deploy.
 */

/** The minimal shape both `fetch`'s Response and the in-process shim satisfy. */
export interface Resp {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}

export interface RequestInitLike {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

const env = loadEnv();
const mode = modeOf(env);

// Built once, lazily, and shared across every in-process call in this worker.
let cached: {
	deps: { repo: Repository; service: TurjumanService };
	app: ReturnType<typeof createApp>;
} | null = null;

function inproc(e: E2EEnv) {
	if (!cached) {
		const client = new DynamoDBClient({
			endpoint: e.endpoint,
			region: e.region ?? "us-east-1",
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
		const repo = new Repository({ tableName: e.tableName, client });
		const deps = { repo, service: new TurjumanService(repo) };
		cached = { deps, app: createApp(deps) };
	}
	return cached;
}

function lowerHeaders(
	headers?: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
	return out;
}

export async function request(
	url: string,
	init: RequestInitLike = {},
): Promise<Resp> {
	if (mode === "inprocess" && env) {
		const u = new URL(url);
		if (u.hostname === "mcp.inproc") {
			const { deps } = inproc(env);
			const r = await processRequest({
				method: init.method ?? "POST",
				path: u.pathname,
				headers: lowerHeaders(init.headers),
				body: init.body ?? "",
				service: deps,
			});
			const body = r.body ?? "";
			return {
				ok: r.statusCode < 400,
				status: r.statusCode,
				json: async () => JSON.parse(body),
				text: async () => body,
			};
		}
		if (u.hostname === "api.inproc") {
			const { app } = inproc(env);
			return app.request(url, {
				method: init.method,
				headers: init.headers,
				body: init.body,
			});
		}
	}
	return fetch(url, init);
}
