#!/usr/bin/env node
// Create the single-table store (if missing) and bootstrap the first OWNER, printing
// their API key. Needs `npm run build` + a running LocalStack (`npm run stack:up`).
//   node scripts/dev-setup.mjs you@example.com "Your Name"
// Honors TURJUMAN_TABLE (default "Turjuman") and AWS_ENDPOINT_URL (default :4566).

import {
  CreateTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { Repository, bootstrapOwner } from "@turjuman/core";

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('Usage: node scripts/dev-setup.mjs <email> "<name>"');
  process.exit(1);
}

const TABLE = process.env.TURJUMAN_TABLE ?? "Turjuman";
const endpoint =
  process.env.AWS_ENDPOINT_URL ?? process.env.AWS_ENDPOINT_URL_DYNAMODB ?? "http://localhost:4566";
const client = new DynamoDBClient({
  endpoint,
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "local",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "local",
  },
});

const gsi = (n) => ({
  IndexName: n,
  KeySchema: [
    { AttributeName: `${n}PK`, KeyType: "HASH" },
    { AttributeName: `${n}SK`, KeyType: "RANGE" },
  ],
  Projection: { ProjectionType: "ALL" },
});

try {
  await client.send(
    new CreateTableCommand({
      TableName: TABLE,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        "PK",
        "SK",
        "GSI1PK",
        "GSI1SK",
        "GSI2PK",
        "GSI2SK",
        "GSI3PK",
        "GSI3SK",
      ].map((n) => ({ AttributeName: n, AttributeType: "S" })),
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [gsi("GSI1"), gsi("GSI2"), gsi("GSI3")],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
  console.log(`Created table ${TABLE}.`);
} catch (err) {
  if (err?.name === "ResourceInUseException") {
    console.log(`Table ${TABLE} already exists — reusing it.`);
  } else {
    throw err;
  }
}

const repo = new Repository({ tableName: TABLE, client });
const { user, secret } = await bootstrapOwner(repo, { email, name });

console.log("\nBootstrapped owner:");
console.log(`  user:   ${user.email} (${user.id})`);
console.log(`  apiKey: ${secret}`);
console.log("\nStore the API key now — it cannot be retrieved again.");
console.log("Local URLs once the servers are running:");
console.log("  MCP: http://localhost:3000/    REST: http://localhost:4000/");
