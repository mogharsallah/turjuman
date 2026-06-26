import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurjumanStackProps } from "@turjuman/aws-cdk";
import { z } from "zod";

/**
 * The deploy configuration is a zod schema = the single source of truth, mirroring
 * the repo's "types off the schema" convention. The canonical copy lives in AWS
 * SSM (see ssm-config.ts) so a redeploy works from any machine/CI; the local
 * `turjuman.deploy.json` is just a cache/override. Safe to commit — it holds no
 * secrets (the API key is shown once and never stored).
 */
export const DEPLOY_CONFIG_FILE = "turjuman.deploy.json";

const functionTuning = z.object({
	architecture: z.enum(["arm64", "x86_64"]).optional(),
	memorySize: z.number().int().positive().optional(),
	timeout: z.number().int().positive().optional(),
});

const surface = functionTuning.extend({ enabled: z.boolean().optional() });

const table = z.object({
	billingMode: z.enum(["PAY_PER_REQUEST", "PROVISIONED"]).optional(),
	readCapacity: z.number().int().positive().optional(),
	writeCapacity: z.number().int().positive().optional(),
	pointInTimeRecovery: z.boolean().optional(),
	deletionProtection: z.boolean().optional(),
});

const vpc = z.object({
	subnetIds: z.array(z.string()).min(1),
	securityGroupIds: z.array(z.string()).optional(),
});

/** Focused deploy config (v2). Same JSON shape lives in SSM (canonical) and the
 * local cache file. */
export const deployConfigSchema = z.object({
	version: z.literal(2),
	stackName: z.string().min(1),
	region: z.string().min(1),
	/** Remembered for re-runs; the owner is created only once. Local-only (PII —
	 * never written to the shared SSM copy). */
	ownerEmail: z.string().email().optional(),
	ownerName: z.string().optional(),
	table: table.optional(),
	functionDefaults: functionTuning.optional(),
	mcp: functionTuning.optional(),
	api: surface.optional(),
	webhook: surface.optional(),
	corsAllowOrigins: z.array(z.string()).optional(),
	vpc: vpc.optional(),
});

export type DeployConfig = z.infer<typeof deployConfigSchema>;

/** The pre-v2, flat config shape the old deployer wrote. Folded into v2 on read. */
interface LegacyConfig {
	stackName: string;
	region: string;
	functionTimeout?: number;
	functionMemorySize?: number;
	corsAllowOrigins?: string[];
	vpcSubnetIds?: string[];
	vpcSecurityGroupIds?: string[];
	ownerEmail?: string;
	ownerName?: string;
	// deployBucket is intentionally dropped — there is no per-deploy bucket now.
}

/**
 * Normalize any persisted config (v1 flat or v2 nested) into a validated v2
 * config. Re-validates through zod so a malformed file/parameter fails loudly.
 */
export function migrateConfig(raw: unknown): DeployConfig {
	if (
		raw &&
		typeof raw === "object" &&
		(raw as { version?: unknown }).version === 2
	) {
		return deployConfigSchema.parse(raw);
	}
	const v1 = raw as LegacyConfig;
	const functionDefaults: z.infer<typeof functionTuning> = {};
	if (v1.functionMemorySize != null)
		functionDefaults.memorySize = v1.functionMemorySize;
	if (v1.functionTimeout != null) functionDefaults.timeout = v1.functionTimeout;

	const migrated: DeployConfig = {
		version: 2,
		stackName: v1.stackName,
		region: v1.region,
		...(v1.ownerEmail ? { ownerEmail: v1.ownerEmail } : {}),
		...(v1.ownerName ? { ownerName: v1.ownerName } : {}),
		...(Object.keys(functionDefaults).length ? { functionDefaults } : {}),
		...(v1.corsAllowOrigins ? { corsAllowOrigins: v1.corsAllowOrigins } : {}),
		...(v1.vpcSubnetIds && v1.vpcSubnetIds.length
			? {
					vpc: {
						subnetIds: v1.vpcSubnetIds,
						...(v1.vpcSecurityGroupIds
							? { securityGroupIds: v1.vpcSecurityGroupIds }
							: {}),
					},
				}
			: {}),
	};
	return deployConfigSchema.parse(migrated);
}

/** Map the validated config onto the @turjuman/aws-cdk stack props. Drops
 * region/owner (deploy-time concerns) and injects nothing for `code`, so the
 * construct's npm-asset defaults apply. */
export function mapConfigToProps(config: DeployConfig): TurjumanStackProps {
	return {
		stackName: config.stackName,
		...(config.table ? { table: config.table } : {}),
		...(config.functionDefaults
			? { functionDefaults: config.functionDefaults }
			: {}),
		...(config.mcp ? { mcp: config.mcp } : {}),
		...(config.api ? { api: config.api } : {}),
		...(config.webhook ? { webhook: config.webhook } : {}),
		...(config.corsAllowOrigins
			? { corsAllowOrigins: config.corsAllowOrigins }
			: {}),
		...(config.vpc ? { vpc: config.vpc } : {}),
	};
}

/** Coerce a `--set` string value to boolean/number where it clearly is one. */
function coerce(value: string): string | number | boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
	return value;
}

/** Apply non-interactive overrides (`--enable`/`--disable`/`--set`), then
 * re-validate through zod so an invalid knob/value fails loudly. */
export function applyOverrides(
	config: DeployConfig,
	opts: { enable?: string[]; disable?: string[]; set?: string[] } = {},
): DeployConfig {
	const next = structuredClone(config) as Record<string, unknown>;

	const setSurface = (name: string, enabled: boolean): void => {
		if (name !== "api" && name !== "webhook") {
			throw new Error(`Unknown surface "${name}". Use "api" or "webhook".`);
		}
		next[name] = { ...((next[name] as object | undefined) ?? {}), enabled };
	};
	for (const name of opts.enable ?? []) setSurface(name, true);
	for (const name of opts.disable ?? []) setSurface(name, false);

	for (const entry of opts.set ?? []) {
		const eq = entry.indexOf("=");
		if (eq < 0) {
			throw new Error(
				`Invalid --set "${entry}". Use path=value, e.g. mcp.memorySize=512.`,
			);
		}
		const path = entry.slice(0, eq).split(".");
		const value = coerce(entry.slice(eq + 1));
		let cursor = next;
		for (let i = 0; i < path.length - 1; i++) {
			const key = path[i]!;
			if (typeof cursor[key] !== "object" || cursor[key] === null)
				cursor[key] = {};
			cursor = cursor[key] as Record<string, unknown>;
		}
		cursor[path[path.length - 1]!] = value;
	}

	return deployConfigSchema.parse(next);
}

export function loadLocalConfig(cwd = process.cwd()): DeployConfig | undefined {
	const file = join(cwd, DEPLOY_CONFIG_FILE);
	if (!existsSync(file)) return undefined;
	return migrateConfig(JSON.parse(readFileSync(file, "utf8")));
}

export function saveLocalConfig(
	config: DeployConfig,
	cwd = process.cwd(),
): string {
	const file = join(cwd, DEPLOY_CONFIG_FILE);
	writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
	return file;
}
