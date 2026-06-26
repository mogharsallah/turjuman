import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_FILE,
	loadAuth,
	loadConfig,
	removeAuth,
	saveAuth,
	saveConfig,
} from "./config.js";
import { CliError } from "./errors.js";

function tmpRepo(config: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "op-cli-"));
	writeFileSync(join(dir, CONFIG_FILE), JSON.stringify(config));
	return dir;
}

/** A throwaway directory to act as a fake ~/.turjuman. */
function tmpAuthDir(): string {
	return mkdtempSync(join(tmpdir(), "op-auth-"));
}

describe("loadConfig", () => {
	it("returns the multi-target form unchanged", () => {
		const dir = tmpRepo({
			projectId: "proj_1",
			targets: [
				{
					format: "json-nested",
					path: "a/{locale}.json",
					namespace: "default",
				},
				{ format: "android", path: "b/{locale}.xml" },
			],
		});
		expect(loadConfig(dir)).toEqual({
			projectId: "proj_1",
			targets: [
				{
					format: "json-nested",
					path: "a/{locale}.json",
					namespace: "default",
				},
				{ format: "android", path: "b/{locale}.xml" },
			],
		});
	});

	it("normalizes the legacy single-target form", () => {
		const dir = tmpRepo({
			projectId: "proj_2",
			format: "json-flat",
			path: "i18n/{locale}.json",
		});
		expect(loadConfig(dir)).toEqual({
			projectId: "proj_2",
			targets: [
				{
					format: "json-flat",
					path: "i18n/{locale}.json",
					namespace: undefined,
				},
			],
		});
	});

	it("throws a usage error when neither targets nor format/path are present", () => {
		const dir = tmpRepo({ projectId: "proj_3" });
		expect(() => loadConfig(dir)).toThrowError(CliError);
		try {
			loadConfig(dir);
		} catch (e) {
			expect((e as CliError).exitCode).toBe(2);
		}
	});

	it("throws a usage error when the file is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "op-cli-empty-"));
		expect(() => loadConfig(dir)).toThrowError(/No turjuman\.config\.json/);
	});

	it("throws a usage error when targets is an empty array", () => {
		const dir = tmpRepo({ projectId: "proj_4", targets: [] });
		expect(() => loadConfig(dir)).toThrowError(CliError);
	});

	it("round-trips a saved config", () => {
		const dir = mkdtempSync(join(tmpdir(), "op-cli-rt-"));
		const config = {
			projectId: "proj_5",
			targets: [
				{
					format: "json-nested",
					path: "locales/{locale}.json",
					namespace: "default",
				},
			],
		};
		saveConfig(config, dir);
		expect(loadConfig(dir)).toEqual(config);
	});
});

describe("auth credentials", () => {
	const saved = {
		url: process.env.TURJUMAN_API_URL,
		key: process.env.TURJUMAN_API_KEY,
	};
	afterEach(() => {
		process.env.TURJUMAN_API_URL = saved.url;
		process.env.TURJUMAN_API_KEY = saved.key;
	});

	function clearEnv(): void {
		delete process.env.TURJUMAN_API_URL;
		delete process.env.TURJUMAN_API_KEY;
	}

	it("uses env vars when both are set, without touching the auth file", () => {
		process.env.TURJUMAN_API_URL = "https://env.example.com";
		process.env.TURJUMAN_API_KEY = "op_live_env";
		// No file written; an unwritten dir would throw if it were read.
		expect(loadAuth(tmpAuthDir())).toEqual({
			url: "https://env.example.com",
			key: "op_live_env",
		});
	});

	it("saveAuth writes the file (0600) and loadAuth reads it back", () => {
		clearEnv();
		const dir = tmpAuthDir();
		const auth = { url: "https://file.example.com", key: "op_live_file" };
		const file = saveAuth(auth, dir);
		expect(file).toBe(join(dir, "auth.json"));
		expect(loadAuth(dir)).toEqual(auth);
		// POSIX permission bits: owner read/write only.
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("merges a partial env override over the file", () => {
		clearEnv();
		const dir = tmpAuthDir();
		saveAuth({ url: "https://file.example.com", key: "op_live_file" }, dir);
		process.env.TURJUMAN_API_URL = "https://env-only.example.com";
		expect(loadAuth(dir)).toEqual({
			url: "https://env-only.example.com",
			key: "op_live_file",
		});
	});

	it("throws a usage error (exit code 2) when neither env nor file provide credentials", () => {
		clearEnv();
		const dir = tmpAuthDir();
		expect(() => loadAuth(dir)).toThrowError(CliError);
		try {
			loadAuth(dir);
		} catch (e) {
			expect((e as CliError).exitCode).toBe(2);
		}
	});

	it("removeAuth returns true when a file existed, false otherwise", () => {
		const dir = tmpAuthDir();
		expect(removeAuth(dir)).toBe(false);
		saveAuth({ url: "https://x", key: "op_live_x" }, dir);
		expect(removeAuth(dir)).toBe(true);
		expect(removeAuth(dir)).toBe(false);
	});
});
