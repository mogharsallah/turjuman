import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How the e2e specs reach the system under test:
 *  - `deployed`: black-box HTTP against the real Lambda Function URLs of a CDK
 *    stack deployed into LocalStack (written by `scripts/e2e-deploy.mjs`). The
 *    only mode that exercises the deploy topology + DynamoDB Streams → webhook.
 *  - `inprocess`: the MCP/REST handlers are invoked directly (no deploy), backed
 *    by LocalStack DynamoDB (provisioned by `helpers/global-setup.ts`). Fast and
 *    parallel-safe; covers everything except the infra-only paths above.
 */
export type E2EMode = "inprocess" | "deployed";

/**
 * Resolved coordinates the e2e specs read instead of hardcoding anything. In
 * `deployed` mode these are the real Function URLs LocalStack mints per stack; in
 * `inprocess` mode `mcpUrl`/`apiUrl` are sentinel hosts (`*.inproc`) the
 * transport routes to the in-process handlers.
 */
export interface E2EEnv {
	/** Defaults to `deployed` when absent (the shape `e2e-deploy.mjs` writes). */
	mode?: E2EMode;
	mcpUrl: string;
	apiUrl: string;
	tableName: string;
	/** API key for the bootstrap owner of the primary org. */
	apiKey: string;
	/** API key for the owner of a SECOND org, for tenant-isolation checks. */
	apiKeyOrgB?: string;
	endpoint?: string;
	region?: string;
}

/** Load `.e2e/env.json`, or null when neither setup path has run (specs self-skip). */
export function loadEnv(): E2EEnv | null {
	try {
		const path = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			".e2e",
			"env.json",
		);
		return JSON.parse(readFileSync(path, "utf8")) as E2EEnv;
	} catch {
		return null;
	}
}

/**
 * The active mode for this run, or null (⇒ every spec self-skips).
 *
 * The mode is opted into explicitly via `TURJUMAN_E2E_MODE` (set by the
 * `e2e:inprocess` / `e2e:test` scripts); the coordinates file only supplies URLs
 * and keys. Keying off the env var — not merely the file's presence — keeps the
 * default hermetic `vitest run` (no var) skipping even if a stale `.e2e/env.json`
 * is left on disk from an earlier e2e run. Both must line up: the run must
 * request a mode AND the matching coordinates must exist.
 */
export function modeOf(env: E2EEnv | null): E2EMode | null {
	const requested = process.env.TURJUMAN_E2E_MODE;
	if (requested !== "inprocess" && requested !== "deployed") return null;
	if (!env) return null;
	return requested;
}
