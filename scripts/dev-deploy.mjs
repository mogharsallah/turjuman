#!/usr/bin/env node
// Deploy the stack into LocalStack with each function's code served from its live
// bundle dir via the construct's `hotReload` prop, so a watcher updates the running
// Lambda without a redeploy. The only local loop running the real Lambda runtime +
// the Streams->webhook path. Prereqs: npm run stack:up and built lambda bundles.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const STACK = process.env.TURJUMAN_DEV_STACK ?? "turjuman-dev";
// Match the host arch so functions run natively under LocalStack (no QEMU).
const ARCH = process.arch === "arm64" ? "arm64" : "x86_64";

export async function devDeploy() {
  // AWS_ENDPOINT_URL routes every service (incl. the CDK toolkit's clients) to LocalStack.
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  process.env.AWS_ENDPOINT_URL ??= ENDPOINT;
  // S3 (only) needs the wildcard-DNS endpoint for the toolkit's virtual-host client.
  process.env.AWS_ENDPOINT_URL_S3 ??= "http://s3.localhost.localstack.cloud:4566";

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { Repository, bootstrapOwner } = await import("@turjuman/core");
  const { deployStack } = await import("../packages/aws-deploy/dist/toolkit.js");

  console.log(`Deploying "${STACK}" into LocalStack (arch ${ARCH}, hot-reload)...`);
  const outputs = await deployStack({
    props: {
      stackName: STACK,
      functionDefaults: { architecture: ARCH },
      // Read from the shard horizon so an early webhook-triggering write isn't missed.
      webhook: { streamStartingPosition: "TRIM_HORIZON" },
      hotReload: {
        mcp: join(root, "packages", "mcp-server", "lambda"),
        api: join(root, "packages", "api", "lambda"),
        webhook: join(root, "packages", "api", "lambda-webhook"),
      },
    },
    region: REGION,
    skipBootstrap: process.env.TURJUMAN_E2E_SKIP_BOOTSTRAP === "1",
  });

  const { McpUrl: mcpUrl, ApiUrl: apiUrl, TableName: tableName } = outputs;
  if (!mcpUrl || !apiUrl || !tableName) {
    throw new Error(`Stack outputs missing McpUrl/ApiUrl/TableName: ${JSON.stringify(outputs)}`);
  }

  // Bootstrap an owner (force:true = idempotent re-runs) and print the one-time key.
  const ddb = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const repo = new Repository({ tableName, client: ddb });
  const { user, secret } = await bootstrapOwner(repo, {
    email: process.env.TURJUMAN_DEV_OWNER_EMAIL ?? "dev-owner@turjuman.test",
    name: "Dev Owner",
    force: true,
  });

  console.log(`\nDeployed "${STACK}".`);
  console.log(`  MCP:     ${mcpUrl}`);
  console.log(`  REST:    ${apiUrl}`);
  console.log(`  table:   ${tableName}`);
  console.log(`  owner:   ${user.email}`);
  console.log(`  apiKey:  ${secret}`);
  console.log("\nUse the key as `Authorization: Bearer <apiKey>`.");
  return { mcpUrl, apiUrl, tableName };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await devDeploy();
}
