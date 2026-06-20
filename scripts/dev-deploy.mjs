#!/usr/bin/env node
// Deploy the Turjuman stack into LocalStack for the hot-reload dev loop. Unlike
// e2e-deploy.mjs (which ships immutable Code.fromAsset bundles), this points each
// function at LocalStack's magic `hot-reload` S3 bucket via the construct's
// `hotReload` prop, so a watching bundler (scripts/dev-lambda.mjs) updates the
// running Lambda code without a redeploy. This is the only local loop where the
// real Lambda runtime runs and the DynamoDB Streams -> webhook path fires.
//
// Prereqs: LocalStack running (npm run stack:up) and the lambda bundle dirs
// present (npm run build, or a running `npm run dev:lambda` watcher).
//
//   node scripts/dev-deploy.mjs            # deploy/redeploy once
//
// Exposes devDeploy() so scripts/dev-lambda.mjs can deploy after its first build.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const REGION = process.env.AWS_REGION ?? "us-east-1";
const STACK = process.env.TURJUMAN_DEV_STACK ?? "turjuman-dev";
// Match the Lambda architecture to the host so functions run natively under
// LocalStack (avoids slow/flaky QEMU emulation).
const ARCH = process.arch === "arm64" ? "arm64" : "x86_64";

export async function devDeploy() {
  // AWS SDK clients (including the CDK toolkit's) honor these; AWS_ENDPOINT_URL
  // routes every service to LocalStack.
  process.env.AWS_REGION = REGION;
  process.env.AWS_DEFAULT_REGION = REGION;
  process.env.AWS_ACCESS_KEY_ID ??= "test";
  process.env.AWS_SECRET_ACCESS_KEY ??= "test";
  process.env.AWS_ENDPOINT_URL ??= ENDPOINT;
  // The toolkit publishes the template with a virtual-host-style S3 client; point
  // S3 (only) at LocalStack's wildcard-DNS endpoint so `<bucket>.s3.localhost...`
  // resolves. Every other service keeps using AWS_ENDPOINT_URL.
  process.env.AWS_ENDPOINT_URL_S3 ??= "http://s3.localhost.localstack.cloud:4566";

  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { Repository, bootstrapOwner } = await import("@turjuman/core");
  const { deployStack } = await import("../packages/aws-deploy/dist/toolkit.js");

  console.log(`Deploying "${STACK}" into LocalStack (arch ${ARCH}, hot-reload)...`);
  const outputs = await deployStack({
    props: {
      stackName: STACK,
      functionDefaults: { architecture: ARCH },
      // Read from the shard horizon so a webhook-triggering write isn't missed
      // before the LocalStack stream poller is live.
      webhook: { streamStartingPosition: "TRIM_HORIZON" },
      // Serve each function's code from the live bundle dir via the hot-reload
      // bucket; the watcher rewrites these and LocalStack re-reads on next invoke.
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

  // Bootstrap an owner against the deployed table and print the one-time key.
  // force:true keeps re-runs idempotent.
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
