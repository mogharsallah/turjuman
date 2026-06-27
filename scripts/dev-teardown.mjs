#!/usr/bin/env node
// Tear down ONLY this working copy's dev stack (the one named in .turjuman-dev),
// leaving the shared LocalStack and every other session's stack intact. This is the
// per-stack counterpart to `pnpm run localstack:down`, which stops the whole emulator.
// The .turjuman-dev marker is left in place so the working copy keeps a stable
// identity across teardown/redeploy cycles (rm it to get a fresh stack name).
//
// Prereq: LocalStack running (pnpm run localstack:up).
//
//   node scripts/dev-teardown.mjs
import { devStackName } from "./dev-stack.mjs";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const CREDS = { accessKeyId: "test", secretAccessKey: "test" };

const STACK = devStackName();
if (!STACK) {
	console.log(
		"No dev stack for this working copy (no .turjuman-dev marker). Nothing to tear down.",
	);
	process.exit(0);
}

process.env.AWS_REGION = REGION;
process.env.AWS_DEFAULT_REGION = REGION;
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
process.env.AWS_ENDPOINT_URL ??= ENDPOINT;

const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
const { DynamoDBClient, DeleteTableCommand } = await import(
	"@aws-sdk/client-dynamodb"
);
const { deleteStack, describeStack } = await import(
	"../packages/deploy-internal/dist/stack.js"
);

const cfn = new CloudFormationClient({
	endpoint: ENDPOINT,
	region: REGION,
	credentials: CREDS,
});
const ddb = new DynamoDBClient({
	endpoint: ENDPOINT,
	region: REGION,
	credentials: CREDS,
});

const stack = await describeStack(cfn, STACK);
if (!stack) {
	console.log(`Dev stack "${STACK}" is not deployed. Nothing to tear down.`);
	process.exit(0);
}

// The table has RemovalPolicy.RETAIN, so the stack delete leaves it orphaned —
// delete it explicitly to fully clean up so the next `pnpm run dev` re-creates it.
const tableName = stack.outputs?.TableName;

console.log(`Tearing down dev stack "${STACK}"...`);
await deleteStack(cfn, STACK, { onStatus: (msg) => console.log(`  ${msg}`) });
if (tableName)
	await ddb
		.send(new DeleteTableCommand({ TableName: tableName }))
		.catch(() => {});

console.log(
	`\nTore down "${STACK}". The shared LocalStack and other sessions are untouched.`,
);
