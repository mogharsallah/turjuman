import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { usageError } from "./errors.js";

/**
 * Machine-local credentials: the API URL + key for this machine, stored in
 * ~/.turjuman/auth.json (NOT committed). Environment variables
 * TURJUMAN_API_URL / TURJUMAN_API_KEY override the file.
 *
 * This module is published under the `@turjuman/cli/auth` subpath so external
 * self-host tooling can write/remove credentials through the same single source
 * as the CLI (the in-CLI `bootstrap` command writes them through here too).
 */

const AUTH_DIR = join(homedir(), ".turjuman");
/** Resolve the credentials file inside a credentials directory. */
const authFile = (dir: string) => join(dir, "auth.json");
/** Absolute path to the machine-local credentials file. Exported so external
 * tooling can remove it without re-deriving the path. */
export const AUTH_FILE = authFile(AUTH_DIR);

export interface AuthConfig {
	url: string;
	key: string;
}

/** The `dir` parameter (default `~/.turjuman`) makes these functions hermetically
 * testable; real callers omit it. */
export function loadAuth(dir = AUTH_DIR): AuthConfig {
	const file = authFile(dir);
	const envUrl = process.env.TURJUMAN_API_URL;
	const envKey = process.env.TURJUMAN_API_KEY;
	if (envUrl && envKey) return { url: envUrl, key: envKey };
	if (existsSync(file)) {
		const stored = JSON.parse(readFileSync(file, "utf8")) as AuthConfig;
		return { url: envUrl ?? stored.url, key: envKey ?? stored.key };
	}
	throw usageError(
		'Not logged in. Run "turjuman login --url <api-url> --key <api-key>" or set TURJUMAN_API_URL / TURJUMAN_API_KEY.',
	);
}

export function saveAuth(auth: AuthConfig, dir = AUTH_DIR): string {
	const file = authFile(dir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
	return file;
}

/** Remove the machine-local credentials file. Returns true if a file was deleted. */
export function removeAuth(dir = AUTH_DIR): boolean {
	const file = authFile(dir);
	if (!existsSync(file)) return false;
	rmSync(file);
	return true;
}
