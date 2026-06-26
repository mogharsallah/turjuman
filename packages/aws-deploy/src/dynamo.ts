import {
	DeleteTableCommand,
	type DynamoDBClient,
	UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";

/**
 * Enable deletion protection on a table. Used by `teardown --keep-table`: the
 * table is declared with RemovalPolicy.RETAIN, so the stack delete already
 * leaves it orphaned; enabling protection afterwards guards that retained data
 * against an accidental later delete.
 */
export async function enableTableDeletionProtection(
	client: DynamoDBClient,
	tableName: string,
): Promise<void> {
	await client.send(
		new UpdateTableCommand({
			TableName: tableName,
			DeletionProtectionEnabled: true,
		}),
	);
}

/**
 * Delete a table outright. Used by a full `teardown`: because the table is
 * retained on stack delete (RemovalPolicy.RETAIN), removing the install
 * completely means deleting the orphaned table explicitly.
 */
export async function deleteTable(
	client: DynamoDBClient,
	tableName: string,
): Promise<void> {
	await client.send(new DeleteTableCommand({ TableName: tableName }));
}
