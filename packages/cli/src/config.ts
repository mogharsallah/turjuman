import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { usageError } from "./errors.js";

/**
 * Per-repo CLI configuration: turjuman.config.json (committed) declares which
 * project/format/paths to sync. Machine-local credentials live in auth.ts
 * (re-exported here for convenience).
 */

export const CONFIG_FILE = "turjuman.config.json";

// Credentials live in a dedicated module (also published as @turjuman/cli/auth).
export {
	AUTH_FILE,
	type AuthConfig,
	loadAuth,
	removeAuth,
	saveAuth,
} from "./auth.js";

/** One output: a format + path pattern + namespace. A project can have several
 * (e.g. JSON for web plus Android XML and iOS .strings/.stringsdict). */
export interface Target {
	/** Format id, e.g. "json-nested", "android", "ios-stringsdict". */
	format: string;
	/** Path pattern with a {locale} placeholder, e.g. "locales/{locale}.json". */
	path: string;
	/** Namespace to read/write. Defaults to "default". */
	namespace?: string;
}

export interface ProjectConfig {
	projectId: string;
	targets: Target[];
}

/** On-disk shape, accepting both the multi-target form and the legacy single form. */
interface StoredConfig {
	projectId: string;
	targets?: Target[];
	format?: string;
	path?: string;
	namespace?: string;
}

function normalize(stored: StoredConfig): ProjectConfig {
	if (stored.targets && stored.targets.length > 0) {
		return { projectId: stored.projectId, targets: stored.targets };
	}
	if (stored.format && stored.path) {
		return {
			projectId: stored.projectId,
			targets: [
				{
					format: stored.format,
					path: stored.path,
					namespace: stored.namespace,
				},
			],
		};
	}
	throw usageError(
		`${CONFIG_FILE} must define at least one target (format + path).`,
	);
}

export function loadConfig(cwd = process.cwd()): ProjectConfig {
	const file = join(cwd, CONFIG_FILE);
	if (!existsSync(file)) {
		throw usageError(`No ${CONFIG_FILE} found. Run "turjuman init" first.`);
	}
	return normalize(JSON.parse(readFileSync(file, "utf8")) as StoredConfig);
}

export function saveConfig(config: ProjectConfig, cwd = process.cwd()): string {
	const file = join(cwd, CONFIG_FILE);
	writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
	return file;
}
