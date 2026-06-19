#!/usr/bin/env node
// Smoke-test the teardown + detection path against LocalStack WITHOUT touching
// the shared `turjuman` e2e stack: deploy a throwaway-named stack, assert
// findManagedStacks discovers it by tag, tear it down (stack + retained table),
// then assert it's gone. Exercises the real deploy/teardown building blocks
// (packages/aws-deploy/src) end-to-end.
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
// S3 (only) goes through LocalStack's wildcard-DNS endpoint so the toolkit's
// virtual-host-style asset publishing resolves; see scripts/e2e-deploy.mjs.
process.env.AWS_ENDPOINT_URL_S3 ??= "http://s3.localhost.localstack.cloud:4566";

const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
const { DynamoDBClient, DeleteTableCommand } = await import("@aws-sdk/client-dynamodb");
const { deployStack } = await import("../packages/aws-deploy/dist/toolkit.js");
const { deleteStack, describeStack, findManagedStacks } = await import(
  "../packages/aws-deploy/dist/stack.js"
);

const cfn = new CloudFormationClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });
const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDS });

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};

// 1. Deploy a throwaway, tagged stack (self-bootstraps LocalStack unless skipped).
console.log(`Deploying "${STACK}" with the CDK toolkit...`);
const outputs = await deployStack({
  props: { stackName: STACK, functionDefaults: { architecture: ARCH } },
  region: REGION,
  skipBootstrap: process.env.TURJUMAN_E2E_SKIP_BOOTSTRAP === "1",
});
const tableName = outputs.TableName;

// 2. Detection: the managed-tag scan should discover it.
console.log("Detecting installs by tag...");
let managed = await findManagedStacks(cfn);
assert(managed.some((m) => m.stackName === STACK), `findManagedStacks discovers "${STACK}"`);

// 3. Teardown: delete the stack. The table has RemovalPolicy.RETAIN, so the
//    stack delete leaves it orphaned — delete it explicitly to fully clean up
//    (this mirrors a non --keep-table teardown).
console.log("Tearing down...");
await deleteStack(cfn, STACK, { onStatus: (msg) => console.log(`  ${msg}`) });
if (tableName) await ddb.send(new DeleteTableCommand({ TableName: tableName })).catch(() => {});

// 4. Verify it's gone and teardown is idempotent.
assert(
  (await describeStack(cfn, STACK)) === undefined,
  `describeStack("${STACK}") is undefined after teardown`,
);
managed = await findManagedStacks(cfn);
assert(!managed.some((m) => m.stackName === STACK), `findManagedStacks no longer lists "${STACK}"`);
await deleteStack(cfn, STACK); // no-op
assert(true, "re-running teardown is a no-op (idempotent)");

console.log("\nTeardown smoke passed.");
