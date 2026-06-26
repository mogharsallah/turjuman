#!/usr/bin/env node
import { bundle as bundleApi } from "../packages/api/scripts/build-lambda.mjs";
// LocalStack Lambda hot-reload dev loop: start the esbuild watchers, wait for the
// first build, deploy pointed at the live bundle dirs, then stay alive. Prereq:
// pnpm run localstack:up. Infra changes (grants/event sources/env) still need a redeploy.
import { bundle as bundleMcp } from "../packages/mcp-server/scripts/build-lambda.mjs";
import { devDeploy } from "./dev-deploy.mjs";
import { streamLogs } from "./dev-logs.mjs";
import { devStackName } from "./dev-stack.mjs";

// Each watcher resolves after its initial build, so the bundle dirs exist before we deploy.
const contexts = [
	...(await bundleMcp({ watch: true })),
	...(await bundleApi({ watch: true })),
];

try {
	await devDeploy();
} catch (err) {
	for (const ctx of contexts) await ctx.dispose();
	throw err;
}

console.log(
	"\nWatching for changes — edit src and LocalStack serves new code on the next invoke.",
);
console.log("Press Ctrl+C to stop.\n");

// Tail the deployed functions' CloudWatch logs back to this terminal (DEV_LOGS=0 to skip).
await streamLogs({
	stackName: devStackName({ create: true }),
	endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
	region: process.env.AWS_REGION ?? "us-east-1",
});

const shutdown = async () => {
	for (const ctx of contexts) await ctx.dispose();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
