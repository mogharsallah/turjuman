import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { clientConfig } from "./aws.js";
import { type DeployConfig, loadLocalConfig } from "./config.js";
import { loadSsmConfig } from "./ssm-config.js";
import { describeStack, findManagedStacks, type StackInfo } from "./stack.js";

const ACTIVE_OK = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE"]);

function resolveRegion(opts: { region?: string }, configured?: string): string {
	const region =
		opts.region ??
		configured ??
		process.env.AWS_REGION ??
		process.env.AWS_DEFAULT_REGION;
	if (!region) throw new Error("Provide --region or set AWS_REGION.");
	return region;
}

/** A one-line summary of which surfaces/knobs a stack is configured with. */
function summarizeConfig(config: DeployConfig): string {
	const api = config.api?.enabled === false ? "off" : "on";
	const webhook = config.webhook?.enabled === false ? "off" : "on";
	const billing = config.table?.billingMode ?? "PAY_PER_REQUEST";
	return `config: api=${api}, webhook=${webhook}, billing=${billing}`;
}

function printStack(
	info: StackInfo,
	{ configured }: { configured?: boolean } = {},
): void {
	const tag = configured ? " (from turjuman.deploy.json)" : "";
	console.log(`\n${info.stackName} [${info.status}]${tag}`);
	const healthy = ACTIVE_OK.has(info.status);
	if (info.outputs.McpUrl) console.log(`  MCP URL:   ${info.outputs.McpUrl}`);
	if (info.outputs.ApiUrl) console.log(`  API URL:   ${info.outputs.ApiUrl}`);
	if (info.outputs.TableName)
		console.log(`  Table:     ${info.outputs.TableName}`);
	if (!healthy) console.log(`  (stack is not in a completed state)`);
}

/**
 * Report whether Turjuman is installed in the targeted AWS account/region.
 * Checks the locally-configured stack (if any) and scans the region for every
 * Turjuman-managed stack by tag, so it works without a local config file or with
 * a renamed stack. For each stack it reads the canonical config from SSM so it
 * reports what is actually configured, not just the local cache.
 */
export async function runStatus(opts: { region?: string } = {}): Promise<void> {
	const existing = loadLocalConfig();
	const region = resolveRegion(opts, existing?.region);
	const cfn = new CloudFormationClient(clientConfig(region));

	console.log(`Region: ${region}`);

	// 1. The stack named in turjuman.deploy.json, if we have one.
	let configuredName: string | undefined;
	if (existing) {
		configuredName = existing.stackName;
		const info = await describeStack(cfn, existing.stackName);
		if (info) {
			printStack(info, { configured: true });
			const ssm = await loadSsmConfig(region, existing.stackName).catch(
				() => undefined,
			);
			console.log(
				`  ${summarizeConfig(ssm ?? existing)}${ssm ? " (from SSM)" : " (from turjuman.deploy.json)"}`,
			);
		} else {
			console.log(
				`\nConfigured stack "${existing.stackName}" not found in ${region}.`,
			);
		}
	}

	// 2. Every managed stack in the region (deduped against the configured one).
	const managed = await findManagedStacks(cfn);
	const others = managed.filter((s) => s.stackName !== configuredName);
	if (others.length > 0) {
		console.log(`\nOther Turjuman installations found in ${region}:`);
		for (const info of others) {
			printStack(info);
			const ssm = await loadSsmConfig(region, info.stackName).catch(
				() => undefined,
			);
			if (ssm) console.log(`  ${summarizeConfig(ssm)} (from SSM)`);
		}
	}

	if (!existing && managed.length === 0) {
		console.log(`\nNo Turjuman installation found in ${region}.`);
	}
}
