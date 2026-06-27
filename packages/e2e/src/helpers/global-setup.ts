import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CreateTableCommand,
	DeleteTableCommand,
	DynamoDBClient,
	waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { bootstrapOwner, Repository } from "@turjuman/core";

/**
 * Vitest global setup for the in-process e2e mode. It runs once before any spec
 * is collected and, ONLY when `TURJUMAN_E2E_MODE=inprocess`, provisions a fresh
 * LocalStack DynamoDB table, bootstraps the same two owners the deployed flow
 * seeds (primary org + a second org for tenant isolation), and writes the
 * coordinates to `.e2e/env.json` — exactly where `loadEnv` looks and mirroring
 * what `scripts/e2e-deploy.mjs` writes for the deployed flow. `mcpUrl`/`apiUrl`
 * are sentinel hosts the transport routes to the in-process handlers.
 *
 * In any other mode (the default hermetic `vitest run`, or the deployed flow) it
 * is a no-op, so it must never touch LocalStack or overwrite the deployed env.
 */
const CREDS = { accessKeyId: "test", secretAccessKey: "test" };

async function createTable(
	client: DynamoDBClient,
	tableName: string,
): Promise<void> {
	await client
		.send(new DeleteTableCommand({ TableName: tableName }))
		.catch(() => undefined);
	const gsi = (n: string) => ({
		IndexName: n,
		KeySchema: [
			{ AttributeName: `${n}PK`, KeyType: "HASH" as const },
			{ AttributeName: `${n}SK`, KeyType: "RANGE" as const },
		],
		Projection: { ProjectionType: "ALL" as const },
	});
	await client.send(
		new CreateTableCommand({
			TableName: tableName,
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
			].map((n) => ({ AttributeName: n, AttributeType: "S" as const })),
			KeySchema: [
				{ AttributeName: "PK", KeyType: "HASH" },
				{ AttributeName: "SK", KeyType: "RANGE" },
			],
			GlobalSecondaryIndexes: [gsi("GSI1"), gsi("GSI2"), gsi("GSI3")],
		}),
	);
	await waitUntilTableExists(
		{ client, maxWaitTime: 30 },
		{ TableName: tableName },
	);
}

export default async function setup(): Promise<() => Promise<void>> {
	if (process.env.TURJUMAN_E2E_MODE !== "inprocess") return async () => {};

	const endpoint =
		process.env.AWS_ENDPOINT_URL_DYNAMODB ??
		process.env.AWS_ENDPOINT_URL ??
		"http://localhost:4566";
	const region = process.env.AWS_REGION ?? "us-east-1";
	const tableName = process.env.TURJUMAN_TABLE ?? "TurjumanInprocessE2E";

	const client = new DynamoDBClient({ endpoint, region, credentials: CREDS });
	await createTable(client, tableName);

	const repo = new Repository({ tableName, client });
	const { secret: apiKey } = await bootstrapOwner(repo, {
		email: "e2e-owner@turjuman.test",
		name: "E2E Owner",
		force: true,
	});
	const { secret: apiKeyOrgB } = await bootstrapOwner(repo, {
		email: "e2e-owner-b@turjuman.test",
		name: "E2E Owner B",
		orgId: "tenant-b",
		force: true,
	});

	const outDir = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		".e2e",
	);
	mkdirSync(outDir, { recursive: true });
	const envFile = join(outDir, "env.json");
	writeFileSync(
		envFile,
		JSON.stringify(
			{
				mode: "inprocess",
				mcpUrl: "http://mcp.inproc/",
				apiUrl: "http://api.inproc/",
				tableName,
				apiKey,
				apiKeyOrgB,
				endpoint,
				region,
			},
			null,
			2,
		),
	);

	return async () => {
		// Drop the table and the coordinates file so a later hermetic run finds no
		// stale state (mode is env-var-gated too, so this is belt-and-suspenders).
		await client
			.send(new DeleteTableCommand({ TableName: tableName }))
			.catch(() => undefined);
		rmSync(envFile, { force: true });
	};
}
