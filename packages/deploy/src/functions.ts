import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The Lambda functions Turjuman deploys. These were previously discovered by
 * parsing template.yaml; the deploy stack is now declared in code (see cdk.ts),
 * so the function set lives here as the single source the bundler and the CDK
 * stack share.
 */

/** A function we bundle with esbuild and ship as a Lambda zip. */
export interface EsbuildFunction {
  /** CloudFormation logical id, e.g. "McpFunction". Kept stable across the
   * SAM→CDK switch (see cdk.ts) so a redeploy updates in place. */
  logicalId: string;
  /** Directory containing the source, relative to the repo root, e.g. "packages/api". */
  codeUri: string;
  /** Entry point relative to `codeUri`, e.g. "src/handler.ts". */
  entryPoint: string;
  /** Output bundle filename Lambda loads, derived from Handler, e.g. "handler.js". */
  outFile: string;
  /** Lambda handler, `<file>.<exportedFn>`, e.g. "handler.handler". */
  handler: string;
  /** Console/description shown in the AWS console. */
  description: string;
  /** esbuild banner injected at the top of the bundle (createRequire shim so an
   * ESM bundle can still `require()` Node built-ins under the Lambda runtime). */
  banner: string;
}

const ESM_REQUIRE_BANNER =
  "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

export const DEPLOY_FUNCTIONS: EsbuildFunction[] = [
  {
    logicalId: "McpFunction",
    codeUri: "packages/mcp-server",
    entryPoint: "src/handler.ts",
    outFile: "handler.js",
    handler: "handler.handler",
    description: "Turjuman MCP server",
    banner: ESM_REQUIRE_BANNER,
  },
  {
    logicalId: "ApiFunction",
    codeUri: "packages/api",
    entryPoint: "src/handler.ts",
    outFile: "handler.js",
    handler: "handler.handler",
    description: "Turjuman REST API",
    banner: ESM_REQUIRE_BANNER,
  },
  {
    logicalId: "WebhookFunction",
    codeUri: "packages/api",
    entryPoint: "src/webhook.ts",
    outFile: "webhook.js",
    handler: "webhook.handler",
    description: "Turjuman webhook dispatcher (DynamoDB Streams)",
    banner: ESM_REQUIRE_BANNER,
  },
];

/** True for the workspaces root package.json (which owns the `packages/*` the
 * deploy bundles from). */
function isRepoRoot(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
    return pkg.workspaces !== undefined && existsSync(join(dir, "packages"));
  } catch {
    return false;
  }
}

/** Walk up from `start` until we find the repo root (the workspaces root that
 * holds `packages/*`). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find the Turjuman repo root (a package.json with workspaces) in ${start} ` +
          "or any parent directory. Run `turjuman deploy` from inside a clone of the repo.",
      );
    }
    dir = parent;
  }
}
