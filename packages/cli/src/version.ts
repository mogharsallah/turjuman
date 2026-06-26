import { readFileSync } from "node:fs";

/**
 * The CLI version, read from this package's package.json at runtime so it never
 * drifts from the published version. From the built layout the file ships as
 * `dist/version.js`, so `../package.json` resolves to the package root.
 */
export function cliVersion(): string {
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as {
		version?: string;
	};
	return pkg.version ?? "0.0.0";
}
