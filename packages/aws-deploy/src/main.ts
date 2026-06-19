#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { bootstrapFirstOwner } from "./bootstrap.js";
import { type RunDeployOptions, runDeploy } from "./index.js";
import { runStatus } from "./status.js";
import { runTeardown } from "./teardown.js";

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

/** Accumulate a repeatable commander option into an array. */
const collect = (value: string, previous: string[]): string[] => [...previous, value];

const program = new Command();
program
  .name("turjuman-aws-deploy")
  .description("Turjuman self-host tooling — deploy, inspect, and tear down the AWS stack.")
  .version(version());

program
  .command("deploy")
  .description("Deploy (or update) the Turjuman stack to your AWS account and create the first owner.")
  .option("--reconfigure", "Re-prompt for settings instead of reusing the saved config")
  .option("--stack-name <name>", "Stack name (defaults to the saved config)")
  .option("--region <region>", "AWS region (defaults to config / AWS_REGION)")
  .option("--skip-bootstrap", "Skip the standard CDK bootstrap (for already-bootstrapped accounts)")
  .option("--enable <surface>", "Enable a surface (api|webhook), then redeploy", collect, [])
  .option("--disable <surface>", "Disable a surface (api|webhook), then redeploy", collect, [])
  .option(
    "--set <path=value>",
    "Override a single config value, e.g. mcp.memorySize=512 (repeatable)",
    collect,
    [],
  )
  .action(async (opts: RunDeployOptions) => {
    await runDeploy(opts);
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
  .description("Delete the Turjuman stack, its SSM config, and (optionally) local config. Destructive.")
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
