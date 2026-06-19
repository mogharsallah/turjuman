#!/usr/bin/env node
// Smoke-test the teardown + detection path against LocalStack WITHOUT touching
// the shared `turjuman` e2e stack: deploy a throwaway-named stack, assert
// `findManagedStacks` discovers it by tag, tear it down (stack + deploy bucket),
// then assert it's gone. Exercises the real deploy/teardown building blocks
// (packages/deploy/src) end-to-end.
//
// Prereqs: LocalStack running (npm run e2e:up) and `npm run build`.
//
//   node scripts/e2e-teardown.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const STACK = "turjuman-teardown-smoke";
const ARCH = process.arch === "arm64" ? "arm64" : "x86_64";
const CREDS = { accessKeyId: "test", secretAccessKey: "test" };

process.env.AWS_REGION = REGION;
process.env.AWS_DEFAULT_REGION = REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.AWS_ENDPOINT_URL ??= ENDPOINT; // routes the CDK toolkit at LocalStack

const { S3Client } = await import("@aws-sdk/client-s3");
const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
const { DynamoDBClient, DeleteTableCommand } = await import("@aws-sdk/client-dynamodb");
const { DEPLOY_FUNCTIONS, findRepoRoot } = await import("../packages/deploy/dist/functions.js");
const { bundleFunction } = await import("../packages/deploy/dist/bundle.js");
const { ensureDeployBucket, uploadArtifact, emptyAndDeleteBucket } = await import("../packages/deploy/dist/s3.js");
const { deployStack } = await import("../packages/deploy/dist/toolkit.js");
const { deleteStack, describeStack, findManagedStacks } = await import("../packages/deploy/dist/stack.js");

const s3 = new S3Client({ endpoint: ENDPOINT, region: REGION, credentials: CREDS, forcePathStyle: true });
const cfn = new CloudFormationClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });
const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

// 1. Deploy a throwaway, tagged stack.
const repoRoot = findRepoRoot(root);
console.log(`Bundling ${DEPLOY_FUNCTIONS.length} functions...`);
const artifacts = [];
for (const fn of DEPLOY_FUNCTIONS) artifacts.push(await bundleFunction(repoRoot, fn));

const bucket = await ensureDeployBucket(s3, REGION);
const code = {};
for (const a of artifacts) {
  const key = await uploadArtifact(s3, bucket, a.logicalId, a.hash, a.zip);
  code[a.logicalId] = { bucket, key };
}
console.log(`Deploying "${STACK}" with the CDK toolkit...`);
const outputs = await deployStack({ stackName: STACK, region: REGION, code, architecture: ARCH });
const tableName = outputs.TableName;

// 2. Detection: the managed-tag scan should discover it.
console.log("Detecting installs by tag...");
let managed = await findManagedStacks(cfn);
assert(managed.some((m) => m.stackName === STACK), `findManagedStacks discovers "${STACK}"`);

// 3. Teardown: delete the stack and the deploy bucket. The table has
//    RemovalPolicy.RETAIN, so the stack delete leaves it orphaned — delete it
//    explicitly to fully clean up (this mirrors a non --keep-table teardown).
console.log("Tearing down...");
await deleteStack(cfn, STACK, { onStatus: (msg) => console.log(`  ${msg}`) });
if (tableName) await ddb.send(new DeleteTableCommand({ TableName: tableName })).catch(() => {});
await emptyAndDeleteBucket(s3, bucket);

// 4. Verify it's gone and teardown is idempotent.
assert((await describeStack(cfn, STACK)) === undefined, `describeStack("${STACK}") is undefined after teardown`);
managed = await findManagedStacks(cfn);
assert(!managed.some((m) => m.stackName === STACK), `findManagedStacks no longer lists "${STACK}"`);
await deleteStack(cfn, STACK); // no-op
await emptyAndDeleteBucket(s3, bucket); // no-op
assert(true, "re-running teardown is a no-op (idempotent)");

console.log("\nTeardown smoke passed.");
