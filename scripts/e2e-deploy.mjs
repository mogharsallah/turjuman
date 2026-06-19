#!/usr/bin/env node
// Deploy the Turjuman CDK stack into LocalStack and seed a bootstrap owner,
// then write the resolved endpoints + API key to packages/e2e/.e2e/env.json for
// the deployed-e2e vitest spec to consume.
//
// This reuses Turjuman's own deploy code path (packages/deploy/src): each
// Lambda is bundled with esbuild — which inlines the @turjuman/core workspace
// package — uploaded to (LocalStack) S3, and deployed with the CDK programmatic
// toolkit pointed at LocalStack via AWS_ENDPOINT_URL (no `cdk bootstrap`). It
// exercises the real deploy logic.
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
// LocalStack (avoids slow/flaky QEMU emulation). Real AWS deploys keep the
// template default of arm64.
const ARCH = process.arch === "arm64" ? "arm64" : "x86_64";
const CREDS = { accessKeyId: "test", secretAccessKey: "test" };

// AWS SDK clients (including the ones the CDK toolkit creates internally) honor
// these. AWS_ENDPOINT_URL routes every service to LocalStack.
process.env.AWS_REGION = REGION;
process.env.AWS_DEFAULT_REGION = REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.AWS_ENDPOINT_URL ??= ENDPOINT;

const { S3Client } = await import("@aws-sdk/client-s3");
const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
const { Repository, bootstrapOwner } = await import("@turjuman/core");
// Reuse the deploy tool's real building blocks (built to dist by `npm run build`).
const { DEPLOY_FUNCTIONS, findRepoRoot } = await import("../packages/deploy/dist/functions.js");
const { bundleFunction } = await import("../packages/deploy/dist/bundle.js");
const { ensureDeployBucket, uploadArtifact } = await import("../packages/deploy/dist/s3.js");
const { deployStack } = await import("../packages/deploy/dist/toolkit.js");

// LocalStack S3 needs path-style addressing (no per-bucket virtual hosts).
const s3 = new S3Client({ endpoint: ENDPOINT, region: REGION, credentials: CREDS, forcePathStyle: true });

// 1. Bundle every Lambda with esbuild (inlines @turjuman/core).
const repoRoot = findRepoRoot(root);
console.log(`Bundling ${DEPLOY_FUNCTIONS.length} functions...`);
const artifacts = [];
for (const fn of DEPLOY_FUNCTIONS) {
  artifacts.push(await bundleFunction(repoRoot, fn));
}

// 2. Upload the zips to a (LocalStack) S3 deploy bucket.
const bucket = await ensureDeployBucket(s3, REGION);
const code = {};
for (const a of artifacts) {
  const key = await uploadArtifact(s3, bucket, a.logicalId, a.hash, a.zip);
  code[a.logicalId] = { bucket, key };
}
console.log(`Uploaded ${artifacts.length} artifacts to s3://${bucket}`);

// 3. Deploy the CDK stack with the programmatic toolkit (no bootstrap; the
//    toolkit talks to LocalStack via AWS_ENDPOINT_URL).
console.log("Deploying CDK stack with the toolkit...");
const outputs = await deployStack({ stackName: STACK, region: REGION, code, architecture: ARCH });
const { McpUrl: mcpUrl, ApiUrl: apiUrl, TableName: tableName } = outputs;
if (!mcpUrl || !apiUrl || !tableName) {
  throw new Error(`Stack outputs missing McpUrl/ApiUrl/TableName: ${JSON.stringify(outputs)}`);
}

// 4. Seed a bootstrap owner directly against the deployed table and capture the
//    one-time API key. force:true keeps re-runs idempotent.
const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });
const repo = new Repository({ tableName, client: ddb });
const { secret: apiKey } = await bootstrapOwner(repo, {
  email: "e2e-owner@turjuman.test",
  name: "E2E Owner",
  force: true,
});

// 4b. Seed a SECOND org's owner so tenant-isolation scenarios have a key from a
//     different org. Same table, distinct orgId — exactly how multi-tenancy works.
const { secret: apiKeyOrgB } = await bootstrapOwner(repo, {
  email: "e2e-owner-b@turjuman.test",
  name: "E2E Owner B",
  orgId: "tenant-b",
  force: true,
});

// 5. Persist for the vitest e2e spec.
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
