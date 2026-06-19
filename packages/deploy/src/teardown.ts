import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import * as p from "@clack/prompts";
import { AUTH_FILE, removeAuth } from "@turjuman/cli/auth";
import { clientConfig } from "./aws.js";
import { DEPLOY_CONFIG_FILE, loadDeployConfig } from "./config.js";
import { deleteTable, enableTableDeletionProtection } from "./dynamo.js";
import { unwrap } from "./prompts.js";
import { emptyAndDeleteBucket } from "./s3.js";
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
 * the DynamoDB table and ALL data), delete the separately-managed S3 deploy
 * bucket, then optionally remove local config/credentials. Idempotent — each
 * step checks existence so a re-run after a partial teardown won't crash.
 */
export async function runTeardown(opts: TeardownOptions = {}): Promise<void> {
  p.intro("Turjuman teardown");

  const existing = loadDeployConfig();
  const stackName = opts.stackName ?? existing?.stackName;
  if (!stackName) {
    throw new Error(
      "No turjuman.deploy.json found. Pass --stack-name (and --region) to target a stack.",
    );
  }
  const region =
    opts.region ?? existing?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Provide --region or set AWS_REGION.");
  // The deploy bucket name (random suffix) is only known from the saved config.
  const deployBucket = existing?.deployBucket;

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
      throw new Error("--yes requires an explicit --stack-name so the wrong stack can't be deleted.");
    }
  } else {
    p.log.warn(
      [
        `This deletes stack "${stackName}" in ${region} (Lambdas, IAM roles, Function URLs).`,
        keepTable
          ? `The DynamoDB table${tableName ? ` (${tableName})` : ""} will be RETAINED with its data.`
          : `It also deletes the DynamoDB table${tableName ? ` (${tableName})` : ""} and ALL translation data — permanently.`,
        deployBucket ? `The deploy bucket "${deployBucket}" will also be removed.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const typed = unwrap(
      await p.text({
        message: `Type the stack name "${stackName}" to confirm`,
        validate: (v) => (v === stackName ? undefined : "Does not match — aborting keeps everything."),
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
    await deleteStack(cfn, stackName, { onStatus: (msg) => stackSpin.message(msg) });
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

  // 3. Empty and delete the deploy bucket (lives outside the stack).
  if (deployBucket) {
    const s3 = new S3Client(clientConfig(region, { s3: true }));
    const bucketSpin = p.spinner();
    bucketSpin.start(`Removing deploy bucket ${deployBucket}`);
    try {
      await emptyAndDeleteBucket(s3, deployBucket);
      bucketSpin.stop("Deploy bucket removed");
    } catch (err: any) {
      if (err?.name === "BucketNotEmpty") {
        bucketSpin.stop("Deploy bucket not empty");
        p.log.warn(
          `Bucket "${deployBucket}" could not be emptied (it may have versioning enabled). Remove it manually.`,
        );
      } else {
        bucketSpin.stop("Deploy bucket removal failed");
        throw err;
      }
    }
  } else {
    p.log.warn(
      `No deploy bucket recorded in config — skipping. Look for a bucket named "turjuman-deploy-${region}-*" and remove it manually if present.`,
    );
  }

  // 4. Offer to remove local config + credentials.
  const removeLocal = unwrap(
    await p.confirm({
      message: "Also remove local turjuman.deploy.json and ~/.turjuman/auth.json?",
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
    p.log.info(removed.length ? `Removed: ${removed.join(", ")}` : "No local files to remove.");
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

  p.outro(retainedTable ? "Turjuman removed (table retained)." : "Turjuman removed.");
}
