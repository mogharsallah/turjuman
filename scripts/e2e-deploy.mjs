#!/usr/bin/env node
// Deploy the Turjuman CDK stack into LocalStack and seed bootstrap owners, then
// write the resolved endpoints + API keys to packages/e2e/.e2e/env.json for the
// deployed-e2e vitest spec to consume.
//
// This reuses Turjuman's own deploy code path (packages/aws-deploy/src): the
// @turjuman/aws-cdk construct deployed with the CDK programmatic toolkit, pointed
// at LocalStack via AWS_ENDPOINT_URL. The Lambda code is the pre-bundled asset
// shipped by @turjuman/mcp-server / @turjuman/api (produced by `npm run build`),
// which the construct ships via Code.fromAsset. The toolkit self-bootstraps the
// standard CDK environment unless TURJUMAN_E2E_SKIP_BOOTSTRAP=1 (in which case
// run `cdklocal bootstrap` first).
//
// Prereqs: LocalStack running (npm run e2e:up) and `npm run build`.
//
//   node scripts/e2e-deploy.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const STACK = "turjuman";
// Match the Lambda architecture to the host so functions run natively under
// LocalStack (avoids slow/flaky QEMU emulation). Real AWS deploys keep arm64.
const ARCH = process.arch === "arm64" ? "arm64" : "x86_64";
const CREDS = { accessKeyId: "test", secretAccessKey: "test" };

// AWS SDK clients (including the ones the CDK toolkit creates internally) honor
// these. AWS_ENDPOINT_URL routes every service to LocalStack.
process.env.AWS_REGION = REGION;
process.env.AWS_DEFAULT_REGION = REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.AWS_ENDPOINT_URL ??= ENDPOINT;
// The CDK toolkit publishes the template + Lambda assets with a virtual-host-style
// S3 client (bucket-as-subdomain), which LocalStack at localhost:4566 can't route.
// Point S3 (only) at LocalStack's wildcard-DNS endpoint, where
// `<bucket>.s3.localhost.localstack.cloud` resolves to 127.0.0.1. This per-service
// override takes precedence over AWS_ENDPOINT_URL for S3; every other service
// keeps using AWS_ENDPOINT_URL.
process.env.AWS_ENDPOINT_URL_S3 ??= "http://s3.localhost.localstack.cloud:4566";

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
const { Repository, bootstrapOwner } = await import("@turjuman/core");
// Reuse the deploy tool's real toolkit (built to dist by `npm run build`).
const { deployStack } = await import("../packages/aws-deploy/dist/toolkit.js");

// 1. Deploy the CDK stack with the programmatic toolkit. The construct resolves
//    the pre-bundled @turjuman/mcp-server / @turjuman/api Lambda assets; the
//    toolkit self-bootstraps LocalStack and talks to it via AWS_ENDPOINT_URL.
console.log("Deploying CDK stack with the toolkit...");
const outputs = await deployStack({
  props: {
    stackName: STACK,
    functionDefaults: { architecture: ARCH },
    // Read the change stream from the shard horizon rather than LATEST. The stack
    // is freshly deployed per run, so there is no history to replay; reading from
    // the horizon removes the flaky race where a webhook-triggering write lands
    // before LocalStack's stream poller is actually live and is silently missed.
    webhook: { streamStartingPosition: "TRIM_HORIZON" },
  },
  region: REGION,
  skipBootstrap: process.env.TURJUMAN_E2E_SKIP_BOOTSTRAP === "1",
});
const { McpUrl: mcpUrl, ApiUrl: apiUrl, TableName: tableName } = outputs;
if (!mcpUrl || !apiUrl || !tableName) {
  throw new Error(`Stack outputs missing McpUrl/ApiUrl/TableName: ${JSON.stringify(outputs)}`);
}

// 2. Seed a bootstrap owner directly against the deployed table and capture the
//    one-time API key. force:true keeps re-runs idempotent.
const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });
const repo = new Repository({ tableName, client: ddb });
const { secret: apiKey } = await bootstrapOwner(repo, {
  email: "e2e-owner@turjuman.test",
  name: "E2E Owner",
  force: true,
});

// 2b. Seed a SECOND org's owner so tenant-isolation scenarios have a key from a
//     different org. Same table, distinct orgId — exactly how multi-tenancy works.
const { secret: apiKeyOrgB } = await bootstrapOwner(repo, {
  email: "e2e-owner-b@turjuman.test",
  name: "E2E Owner B",
  orgId: "tenant-b",
  force: true,
});

// 3. Persist for the vitest e2e spec.
const outDir = join(root, "packages", "e2e", ".e2e");
mkdirSync(outDir, { recursive: true });
const envFile = join(outDir, "env.json");
writeFileSync(
  envFile,
  JSON.stringify(
    { mcpUrl, apiUrl, tableName, apiKey, apiKeyOrgB, endpoint: ENDPOINT, region: REGION },
    null,
    2,
  ),
);

console.log(`\nDeployed stack "${STACK}" (arch ${ARCH}). Wrote ${envFile}`);
console.log({ mcpUrl, apiUrl, tableName });
