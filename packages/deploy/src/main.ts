#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { runDeploy } from "./index.js";
import { runStatus } from "./status.js";
import { runTeardown } from "./teardown.js";
import { bootstrapFirstOwner } from "./bootstrap.js";

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

const program = new Command();
program
  .name("turjuman-deploy")
  .description("Turjuman self-host tooling — deploy, inspect, and tear down the AWS stack.")
  .version(version());

program
  .command("deploy")
  .description("Deploy (or update) the Turjuman stack to your AWS account and create the first owner.")
  .option("--reconfigure", "Re-prompt for settings instead of reusing turjuman.deploy.json")
  .action(async (opts: { reconfigure?: boolean }) => {
    await runDeploy({ reconfigure: opts.reconfigure });
  });

program
  .command("status")
  .description("Show whether Turjuman is installed in the target AWS account/region.")
  .option("--region <region>", "AWS region (defaults to config / AWS_REGION)")
  .action(async (opts: { region?: string }) => {
    await runStatus({ region: opts.region });
  });

program
  .command("teardown")
  .description("Delete the Turjuman stack, deploy bucket, and (optionally) local config. Destructive.")
  .option("--stack-name <name>", "Stack name (defaults to turjuman.deploy.json)")
  .option("--region <region>", "AWS region (defaults to config / AWS_REGION)")
  .option("--keep-table", "Retain the DynamoDB table (and its data) instead of deleting it")
  .option("--yes", "Skip the typed confirmation (requires --stack-name)")
  .action(async (opts: { stackName?: string; region?: string; keepTable?: boolean; yes?: boolean }) => {
    await runTeardown(opts);
  });

program
  .command("bootstrap")
  .description("Create the first owner against a deployed DynamoDB table (for manual deploys).")
  .requiredOption("--table <name>", "DynamoDB table name (the TableName stack output)")
  .requiredOption("--email <email>", "Owner email")
  .requiredOption("--name <name>", "Owner name")
  .option("--region <region>", "AWS region", process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION)
  .action(async (opts: { table: string; email: string; name: string; region?: string }) => {
    if (!opts.region) throw new Error("Provide --region or set AWS_REGION.");
    const owner = await bootstrapFirstOwner({
      region: opts.region,
      tableName: opts.table,
      email: opts.email,
      name: opts.name,
    });
    if (!owner) {
      console.log("Org already has users — bootstrap skipped. Reuse your existing API key.");
      return;
    }
    console.log(`Owner created: ${owner.email} (${owner.userId})`);
    console.log(`API key: ${owner.apiKey}`);
    console.log("Store this now — it is shown only once.");
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
