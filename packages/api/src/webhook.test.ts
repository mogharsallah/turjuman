import { createHmac } from "node:crypto";
import http from "node:http";
import {
	CreateTableCommand,
	DeleteTableCommand,
	DynamoDBClient,
	waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
	authenticate,
	bootstrapOwner,
	Repository,
	TurjumanService,
	webhookEventSchema,
} from "@turjuman/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handler, RULE_EVENTS } from "./webhook.js";

/**
 * Exercises the DynamoDB Streams → webhook dispatcher against DynamoDB Local and
 * a real local HTTP receiver. Skipped unless AWS_ENDPOINT_URL_DYNAMODB is set.
 */
const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
const TABLE = process.env.TURJUMAN_TABLE ?? "TurjumanWh";

const client = new DynamoDBClient({
	endpoint,
	region: process.env.AWS_REGION ?? "us-east-1",
	credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const repo = new Repository({ tableName: TABLE, client });
const svc = new TurjumanService(repo);
let server: http.Server;

async function createTable(): Promise<void> {
	await client
		.send(new DeleteTableCommand({ TableName: TABLE }))
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
			].map((n) => ({ AttributeName: n, AttributeType: "S" as const })),
			KeySchema: [
				{ AttributeName: "PK", KeyType: "HASH" },
				{ AttributeName: "SK", KeyType: "RANGE" },
			],
			GlobalSecondaryIndexes: [gsi("GSI1"), gsi("GSI2"), gsi("GSI3")],
		}),
	);
	await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
}

describe.skipIf(!endpoint)("webhook dispatcher", () => {
	beforeAll(createTable, 60_000);
	afterAll(async () => {
		server?.close();
		await client
			.send(new DeleteTableCommand({ TableName: TABLE }))
			.catch(() => undefined);
	});

	it("delivers an HMAC-signed POST for a matching event", async () => {
		const received = new Promise<{
			headers: http.IncomingHttpHeaders;
			body: string;
		}>((resolve) => {
			server = http
				.createServer((req, res) => {
					let body = "";
					req.on("data", (d) => (body += d));
					req.on("end", () => {
						res.end("ok");
						resolve({ headers: req.headers, body });
					});
				})
				.listen(0);
		});
		const port = (server.address() as { port: number }).port;

		const boot = await bootstrapOwner(repo, { email: "o@wh.com", name: "O" });
		const { actor } = (await authenticate(repo, boot.secret))!;
		const project = await svc.projects.create(actor, {
			name: "Hooked",
			baseLocale: "en",
		});
		const webhook = await svc.webhooks.add(actor, project.id, {
			url: `http://127.0.0.1:${port}/hook`,
			events: ["translation.updated"],
		});

		// Synthetic stream record for a translation cell change — the new-model
		// attribute names, exactly as the dispatcher reads them off the raw image.
		const NewImage = marshall({
			entityType: "Translation",
			projectId: project.id,
			keyId: "key_greeting",
			branchId: "main",
			locale: "fr",
			lifecycle: "accepted",
			value: "Bonjour",
		});
		await handler({
			Records: [{ eventName: "MODIFY", dynamodb: { NewImage } }],
		});

		const { headers, body } = await received;
		expect(headers["x-turjuman-event"]).toBe("translation.updated");
		const expected =
			"sha256=" +
			createHmac("sha256", webhook.secret).update(body).digest("hex");
		expect(headers["x-turjuman-signature"]).toBe(expected);
		expect(JSON.parse(body)).toMatchObject({
			event: "translation.updated",
			projectId: project.id,
			data: { keyId: "key_greeting", branchId: "main", locale: "fr" },
		});
	}, 30_000);
});

/**
 * Hermetic guard (runs without DynamoDB): every subscribable event must be
 * produced by the declarative rule table, so adding a value to
 * `webhookEventSchema` without a rule fails here instead of silently never
 * firing. `translation.stale` is the one derived (non-1:1) signal, emitted
 * outside the table.
 */
describe("webhook event coverage", () => {
	it("covers every webhookEventSchema value with a rule (bar the derived stale signal)", () => {
		const derived = new Set(["translation.stale"]);
		const uncovered = webhookEventSchema.options.filter(
			(event) => !RULE_EVENTS.has(event) && !derived.has(event),
		);
		expect(uncovered).toEqual([]);
	});
});
