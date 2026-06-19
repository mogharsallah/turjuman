import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolved deployment coordinates written by `scripts/e2e-deploy.mjs` after it
 * deploys the SAM stack into LocalStack. Every e2e spec reads this instead of
 * hardcoding Function URLs (which LocalStack mints per stack).
 */
export interface E2EEnv {
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

/** Load `.e2e/env.json`, or null when the deploy step hasn't run (specs self-skip). */
export function loadEnv(): E2EEnv | null {
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".e2e", "env.json");
    return JSON.parse(readFileSync(path, "utf8")) as E2EEnv;
  } catch {
    return null;
  }
}
