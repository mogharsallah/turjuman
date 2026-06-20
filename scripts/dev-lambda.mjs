#!/usr/bin/env node
// LocalStack Lambda hot-reload dev loop: start the esbuild watchers, wait for the
// first build, deploy pointed at the live bundle dirs, then stay alive. Prereq:
// npm run stack:up. Infra changes (grants/event sources/env) still need a redeploy.
import { bundle as bundleMcp } from "../packages/mcp-server/scripts/build-lambda.mjs";
import { bundle as bundleApi } from "../packages/api/scripts/build-lambda.mjs";
import { devDeploy } from "./dev-deploy.mjs";

// Each watcher resolves after its initial build, so the bundle dirs exist before we deploy.
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
