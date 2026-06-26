import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import * as p from "@clack/prompts";
import { AUTH_FILE, removeAuth } from "@turjuman/cli/auth";
import { clientConfig } from "./aws.js";
import { DEPLOY_CONFIG_FILE, loadLocalConfig } from "./config.js";
import { deleteTable, enableTableDeletionProtection } from "./dynamo.js";
import { unwrap } from "./prompts.js";
import { deleteSsmConfig, ssmConfigPath } from "./ssm-config.js";
import { deleteStack, describeStack } from "./stack.js";

export interface TeardownOptions {
	stackName?: string;
	region?: string;
	/** Skip the typed confirmation (for automation). Requires an explicit stack name. */
	yes?: boolean;
	/** Preserve the DynamoDB table (and its data) instead of deleting it with the stack. */
	keepTable?: boolean;
}

/**
 * Remove a Turjuman installation: delete the CloudFormation stack (and with it
 * the Lambdas/roles/Function URLs), handle the retained DynamoDB table, and
 * delete the stack's SSM config parameter. It deliberately does NOT touch the
 * shared CDK bootstrap (`CDKToolkit`) stack or its staging bucket, which other
 * stacks may share. Idempotent — each step checks existence so a re-run after a
 * partial teardown won't crash.
 */
export async function runTeardown(opts: TeardownOptions = {}): Promise<void> {
	p.intro("Turjuman teardown");

	const existing = loadLocalConfig();
	const stackName = opts.stackName ?? existing?.stackName;
	if (!stackName) {
		throw new Error(
			"No turjuman.deploy.json found. Pass --stack-name (and --region) to target a stack.",
		);
	}
	const region =
		opts.region ??
		existing?.region ??
		process.env.AWS_REGION ??
		process.env.AWS_DEFAULT_REGION;
	if (!region) throw new Error("Provide --region or set AWS_REGION.");

	const cfn = new CloudFormationClient(clientConfig(region));

	// Look up the table name up front so the confirmation names what gets destroyed.
	const info = await describeStack(cfn, stackName);
	if (!info) {
		p.log.warn(`Stack "${stackName}" not found in ${region}.`);
	}
	const tableName = info?.outputs.TableName;
	const keepTable = Boolean(opts.keepTable);

	// Strong, typed confirmation. The data line flips depending on --keep-table.
	if (opts.yes) {
		if (!opts.stackName) {
			throw new Error(
				"--yes requires an explicit --stack-name so the wrong stack can't be deleted.",
			);
		}
	} else {
		p.log.warn(
			[
				`This deletes stack "${stackName}" in ${region} (Lambdas, IAM roles, Function URLs).`,
				keepTable
					? `The DynamoDB table${tableName ? ` (${tableName})` : ""} will be RETAINED with its data.`
					: `It also deletes the DynamoDB table${tableName ? ` (${tableName})` : ""} and ALL translation data — permanently.`,
				`The SSM config parameter (${ssmConfigPath(stackName)}) will also be removed.`,
				"The shared CDK bootstrap (CDKToolkit) stack is left untouched.",
			].join("\n"),
		);
		const typed = unwrap(
			await p.text({
				message: `Type the stack name "${stackName}" to confirm`,
				validate: (v) =>
					v === stackName
						? undefined
						: "Does not match — aborting keeps everything.",
			}),
		);
		if (typed !== stackName) {
			p.cancel("Teardown cancelled.");
			return;
		}
	}

	// 1. Delete the CloudFormation stack (Lambdas, IAM, Function URLs). The
	//    DynamoDB table is declared with RemovalPolicy.RETAIN, so it is retained
	//    (orphaned) by the stack delete — handled explicitly in step 2.
	const stackSpin = p.spinner();
	stackSpin.start("Deleting CloudFormation stack");
	try {
		await deleteStack(cfn, stackName, {
			onStatus: (msg) => stackSpin.message(msg),
		});
	} catch (err) {
		stackSpin.stop("Stack deletion failed");
		throw err;
	}
	stackSpin.stop("Stack deleted");

	// 2. Handle the retained table: delete it on a full teardown, or protect it
	//    (keeping the data) with --keep-table.
	let retainedTable: string | undefined;
	if (info && tableName) {
		const ddb = new DynamoDBClient(clientConfig(region));
		if (keepTable) {
			const protectSpin = p.spinner();
			protectSpin.start("Protecting the retained table from deletion");
			await enableTableDeletionProtection(ddb, tableName);
			protectSpin.stop(`Table ${tableName} retained and protected`);
			retainedTable = tableName;
		} else {
			const dropSpin = p.spinner();
			dropSpin.start("Deleting the table and all data");
			await deleteTable(ddb, tableName);
			dropSpin.stop("Table deleted");
		}
	} else if (keepTable) {
		p.log.warn(
			"Could not resolve the table name from stack outputs. If a table was retained, remove or keep it manually.",
		);
	}

	// 3. Delete the stack's canonical SSM config parameter (idempotent).
	const ssmSpin = p.spinner();
	ssmSpin.start("Removing the SSM config parameter");
	try {
		await deleteSsmConfig(region, stackName);
		ssmSpin.stop("SSM config parameter removed");
	} catch (err) {
		ssmSpin.stop("Could not remove the SSM config parameter");
		p.log.warn(
			`Remove ${ssmConfigPath(stackName)} manually if it remains: ${(err as Error).message}`,
		);
	}

	// 4. Offer to remove local config + credentials.
	const removeLocal = unwrap(
		await p.confirm({
			message:
				"Also remove local turjuman.deploy.json and ~/.turjuman/auth.json?",
			initialValue: false,
		}),
	);
	if (removeLocal) {
		const configFile = join(process.cwd(), DEPLOY_CONFIG_FILE);
		const removed: string[] = [];
		if (existsSync(configFile)) {
			rmSync(configFile);
			removed.push(DEPLOY_CONFIG_FILE);
		}
		if (removeAuth()) removed.push(AUTH_FILE);
		p.log.info(
			removed.length
				? `Removed: ${removed.join(", ")}`
				: "No local files to remove.",
		);
	}

	if (retainedTable) {
		p.note(
			[
				`Table "${retainedTable}" was kept, with deletion protection enabled.`,
				"To delete it later: disable deletion protection, then delete the table —",
				`  aws dynamodb update-table --table-name ${retainedTable} --no-deletion-protection-enabled --region ${region}`,
				`  aws dynamodb delete-table --table-name ${retainedTable} --region ${region}`,
			].join("\n"),
			"Retained data",
		);
	}

	p.outro(
		retainedTable ? "Turjuman removed (table retained)." : "Turjuman removed.",
	);
}
