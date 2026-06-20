#!/usr/bin/env node
// One-command LocalStack Lambda hot-reload dev loop. Starts an esbuild watcher
// per function bundle (resolving @turjuman/* to src for cross-package reload),
// waits for the first build, deploys the stack pointed at the live bundle dirs,
// then stays alive so saves rebuild the mounted code and LocalStack serves it on
// the next invoke. This is the high-fidelity counterpart to `npm run dev`.
//
//   node scripts/dev-lambda.mjs
//
// Prereq: LocalStack running (npm run stack:up). Note: changes to the *infra*
// (new IAM grants, event sources, env vars) still need a redeploy — re-run this
// command, or `npm run dev:lambda:deploy` against the running watchers.
import { bundle as bundleMcp } from "../packages/mcp-server/scripts/build-lambda.mjs";
import { bundle as bundleApi } from "../packages/api/scripts/build-lambda.mjs";
import { devDeploy } from "./dev-deploy.mjs";

// Start both watchers; each resolves only after its initial build completes, so
// the bundle dirs are populated before we deploy.
const contexts = [...(await bundleMcp({ watch: true })), ...(await bundleApi({ watch: true }))];

try {
  await devDeploy();
} catch (err) {
  for (const ctx of contexts) await ctx.dispose();
  throw err;
}

console.log("\nWatching for changes — edit src and LocalStack serves new code on the next invoke.");
console.log("Press Ctrl+C to stop.");

const shutdown = async () => {
  for (const ctx of contexts) await ctx.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
