import * as p from "@clack/prompts";
import { saveAuth } from "@turjuman/cli/auth";
import { bootstrapFirstOwner } from "./bootstrap.js";
import {
	applyOverrides,
	type DeployConfig,
	deployConfigSchema,
	loadLocalConfig,
	mapConfigToProps,
	saveLocalConfig,
} from "./config.js";
import { unwrap } from "./prompts.js";
import { loadSsmConfig, saveSsmConfig } from "./ssm-config.js";
import { deployStack } from "./toolkit.js";

const splitList = (s: string): string[] =>
	s
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);

/** Gather deploy settings interactively, seeded by any resolved config. */
async function gatherConfig(
	existing: DeployConfig | undefined,
): Promise<DeployConfig> {
	const envRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

	const stackName = unwrap(
		await p.text({
			message: "CloudFormation stack name",
			initialValue: existing?.stackName ?? "turjuman",
		}),
	);
	const region = unwrap(
		await p.text({
			message: "AWS region",
			initialValue: existing?.region ?? envRegion ?? "us-east-1",
		}),
	);
	const cors = unwrap(
		await p.text({
			message: "Allowed CORS origins (comma-separated, * for any)",
			initialValue: (existing?.corsAllowOrigins ?? ["*"]).join(","),
		}),
	);
	const memory = unwrap(
		await p.text({
			message: "Lambda memory (MB)",
			initialValue: String(existing?.functionDefaults?.memorySize ?? 256),
			validate: (v) =>
				Number.isFinite(Number(v)) ? undefined : "Enter a number",
		}),
	);
	const timeout = unwrap(
		await p.text({
			message: "Lambda timeout (seconds)",
			initialValue: String(existing?.functionDefaults?.timeout ?? 15),
			validate: (v) =>
				Number.isFinite(Number(v)) ? undefined : "Enter a number",
		}),
	);
	const apiEnabled = unwrap(
		await p.confirm({
			message: "Deploy the REST API (for the developer CLI / CI sync)?",
			initialValue: existing?.api?.enabled !== false,
		}),
	);
	const webhookEnabled = unwrap(
		await p.confirm({
			message: "Deploy the webhook dispatcher (DynamoDB Streams → HTTP POSTs)?",
			initialValue: existing?.webhook?.enabled !== false,
		}),
	);
	const pitr = unwrap(
		await p.confirm({
			message:
				"Enable point-in-time recovery (continuous backups) on the table?",
			initialValue: existing?.table?.pointInTimeRecovery ?? false,
		}),
	);
	const deletionProtection = unwrap(
		await p.confirm({
			message: "Enable deletion protection on the table?",
			initialValue: existing?.table?.deletionProtection ?? false,
		}),
	);

	const useVpc = unwrap(
		await p.confirm({
			message: "Run the functions inside a VPC?",
			initialValue: Boolean(existing?.vpc?.subnetIds?.length),
		}),
	);
	let vpc: DeployConfig["vpc"];
	if (useVpc) {
		const subnetIds = splitList(
			unwrap(
				await p.text({
					message: "VPC subnet ids (comma-separated)",
					initialValue: (existing?.vpc?.subnetIds ?? []).join(","),
				}),
			),
		);
		const securityGroupIds = splitList(
			unwrap(
				await p.text({
					message: "VPC security group ids (comma-separated)",
					initialValue: (existing?.vpc?.securityGroupIds ?? []).join(","),
				}),
			),
		);
		vpc = {
			subnetIds,
			...(securityGroupIds.length ? { securityGroupIds } : {}),
		};
	}

	const table: NonNullable<DeployConfig["table"]> = {};
	if (pitr) table.pointInTimeRecovery = true;
	if (deletionProtection) table.deletionProtection = true;

	return deployConfigSchema.parse({
		version: 2,
		stackName,
		region,
		...(existing?.ownerEmail ? { ownerEmail: existing.ownerEmail } : {}),
		...(existing?.ownerName ? { ownerName: existing.ownerName } : {}),
		corsAllowOrigins: splitList(cors),
		functionDefaults: { memorySize: Number(memory), timeout: Number(timeout) },
		api: { enabled: apiEnabled },
		webhook: { enabled: webhookEnabled },
		...(Object.keys(table).length ? { table } : {}),
		...(vpc ? { vpc } : {}),
	});
}

export interface RunDeployOptions {
	reconfigure?: boolean;
	stackName?: string;
	region?: string;
	/** Skip the standard CDK bootstrap (for already-bootstrapped accounts). */
	skipBootstrap?: boolean;
	/** Non-interactive single-knob overrides. */
	set?: string[];
	enable?: string[];
	disable?: string[];
}

/** Resolve the base config before overrides: SSM (canonical) → local cache. */
async function resolveBaseConfig(
	opts: RunDeployOptions,
	local: DeployConfig | undefined,
): Promise<{ config?: DeployConfig; source: "SSM" | "local" | "none" }> {
	const stackName = opts.stackName ?? local?.stackName;
	const region =
		opts.region ??
		local?.region ??
		process.env.AWS_REGION ??
		process.env.AWS_DEFAULT_REGION;
	if (stackName && region) {
		const ssm = await loadSsmConfig(region, stackName).catch(() => undefined);
		if (ssm) {
			// SSM omits PII — re-attach the owner from the local cache if we have it.
			return {
				config: {
					...ssm,
					...((ssm.ownerEmail ?? local?.ownerEmail)
						? { ownerEmail: ssm.ownerEmail ?? local?.ownerEmail }
						: {}),
					...((ssm.ownerName ?? local?.ownerName)
						? { ownerName: ssm.ownerName ?? local?.ownerName }
						: {}),
				},
				source: "SSM",
			};
		}
	}
	if (local) return { config: local, source: "local" };
	return { source: "none" };
}

/** Persist the canonical config to SSM and cache it locally. */
async function persistConfig(config: DeployConfig): Promise<void> {
	saveLocalConfig(config);
	try {
		await saveSsmConfig(config.region, config);
	} catch (err) {
		p.log.warn(
			`Could not write the canonical config to SSM: ${(err as Error).message}`,
		);
	}
}

export async function runDeploy(opts: RunDeployOptions = {}): Promise<void> {
	p.intro("Turjuman deploy");

	const local = loadLocalConfig();
	const { config: base, source } = await resolveBaseConfig(opts, local);

	let config: DeployConfig;
	if (base && !opts.reconfigure) {
		p.log.info(
			source === "SSM"
				? `Using the canonical config from SSM (stack "${base.stackName}").`
				: `Using saved settings from turjuman.deploy.json (stack "${base.stackName}").`,
		);
		p.log.info(
			"Run `turjuman-aws-deploy deploy --reconfigure` to change them.",
		);
		config = base;
	} else {
		config = await gatherConfig(base);
	}

	// Non-interactive single-knob overrides (re-validated through zod).
	config = applyOverrides(config, opts);

	// Deploy the stack (config is baked into the synthesized template; the toolkit
	// self-bootstraps unless --skip-bootstrap and deploys with ambient credentials).
	const deploySpin = p.spinner();
	deploySpin.start(
		opts.skipBootstrap
			? "Deploying CloudFormation stack"
			: "Bootstrapping and deploying",
	);
	let outputs: Record<string, string>;
	try {
		outputs = await deployStack({
			props: mapConfigToProps(config),
			region: config.region,
			skipBootstrap: opts.skipBootstrap,
		});
	} catch (err) {
		deploySpin.stop("Deploy failed");
		throw err;
	}
	deploySpin.stop("Stack deployed");

	await persistConfig(config);

	const apiUrl = outputs.ApiUrl;
	const tableName = outputs.TableName;
	if (!tableName)
		throw new Error(
			"Stack did not return a TableName output — cannot bootstrap.",
		);
	p.note(
		[
			`MCP URL:   ${outputs.McpUrl ?? "(missing)"}`,
			`API URL:   ${apiUrl ?? "(API surface disabled)"}`,
			`Table:     ${tableName}`,
		].join("\n"),
		"Stack outputs",
	);

	// Create the first owner (once) and log in locally.
	let email = config.ownerEmail;
	let name = config.ownerName;
	if (!email) {
		email = unwrap(
			await p.text({
				message: "First owner email",
				validate: (v) => (v.includes("@") ? undefined : "Enter an email"),
			}),
		);
	}
	if (!name) {
		name = unwrap(await p.text({ message: "First owner name" }));
	}

	const bootSpin = p.spinner();
	bootSpin.start("Creating the first owner");
	const owner = await bootstrapFirstOwner({
		region: config.region,
		tableName,
		email,
		name,
	});
	bootSpin.stop(
		owner
			? "Owner created"
			: "Owner already existed — keeping your existing key",
	);

	// The owner is PII — cache it locally only (saveSsmConfig already stripped it).
	config = { ...config, ownerEmail: email, ownerName: name };
	saveLocalConfig(config);

	if (owner) {
		if (apiUrl) saveAuth({ url: apiUrl, key: owner.apiKey });
		p.note(
			[
				`API key: ${owner.apiKey}`,
				"",
				"Store this now — it is shown only once.",
				apiUrl ? "Saved to ~/.turjuman/auth.json (you're logged in)." : "",
			]
				.filter(Boolean)
				.join("\n"),
			"First owner",
		);
	} else {
		p.log.info(
			"The org already has users; reuse your existing API key, or rotate it via the API.",
		);
	}

	p.outro(
		"Done. Point your MCP client at the MCP URL with your API key as a Bearer token.",
	);
}
