#!/usr/bin/env node
// One-time backfill for the key/translation lifecycle model (Phase 4): the
// `reviewed` -> `approved` status rename + dual-slot delivery, key `state`, and
// translation `origin`/provenance. Safe to run repeatedly (idempotent) and is a
// dry-run unless you pass --apply.
//
//   node scripts/migrate-lifecycle.mjs            # report what would change
//   node scripts/migrate-lifecycle.mjs --apply    # write the changes
//
// Honors TURJUMAN_TABLE (default "Turjuman"). For DynamoDB Local / LocalStack
// set AWS_ENDPOINT_URL_DYNAMODB; against a real AWS account it uses the default
// credential chain (env / profile / role).
//
// Note: `sourceRef` is intentionally NOT backfilled — a translation with no
// sourceRef is simply never reported as stale until its next write stamps one,
// which is exactly the desired "nothing stale on day one" behaviour.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
	DynamoDBDocumentClient,
	ScanCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.TURJUMAN_TABLE ?? "Turjuman";
const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
const apply = process.argv.includes("--apply");

const base = new DynamoDBClient(
	endpoint
		? {
				endpoint,
				region: process.env.AWS_REGION ?? "us-east-1",
				credentials: { accessKeyId: "local", secretAccessKey: "local" },
			}
		: {},
);
const doc = DynamoDBDocumentClient.from(base, {
	marshallOptions: { removeUndefinedValues: true },
});

/** Compute the attributes to backfill for one item (empty = nothing to do). */
function plan(item) {
	const updates = {};
	if (item.entityType === "TranslationKey") {
		if (item.state === undefined) updates.state = "active";
		if (item.lastSeenAt === undefined) {
			updates.lastSeenAt = item.updatedAt ?? new Date().toISOString();
		}
	} else if (item.entityType === "Translation") {
		if (item.status === "reviewed") {
			updates.status = "approved";
			if (item.approvedValue === undefined) updates.approvedValue = item.value;
		}
		if (item.origin === undefined) updates.origin = "import";
	}
	return updates;
}

let scanned = 0;
let keysFixed = 0;
let transFixed = 0;
let ExclusiveStartKey;
do {
	const page = await doc.send(
		new ScanCommand({ TableName: TABLE, ExclusiveStartKey }),
	);
	for (const item of page.Items ?? []) {
		scanned++;
		const updates = plan(item);
		const fields = Object.keys(updates);
		if (fields.length === 0) continue;
		if (item.entityType === "TranslationKey") keysFixed++;
		else transFixed++;
		if (apply) {
			const names = {};
			const values = {};
			const sets = fields.map((f, i) => {
				names[`#f${i}`] = f;
				values[`:v${i}`] = updates[f];
				return `#f${i} = :v${i}`;
			});
			await doc.send(
				new UpdateCommand({
					TableName: TABLE,
					Key: { PK: item.PK, SK: item.SK },
					UpdateExpression: `SET ${sets.join(", ")}`,
					ExpressionAttributeNames: names,
					ExpressionAttributeValues: values,
				}),
			);
		}
	}
	ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(
	`${apply ? "Applied" : "Would update"}: ${keysFixed} keys, ${transFixed} translations ` +
		`(scanned ${scanned} items in ${TABLE}).`,
);
if (!apply) console.log("Re-run with --apply to write the changes.");
