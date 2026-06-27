#!/usr/bin/env node
// Vendor the three pre-built Lambda bundles into this package's own lambda/ tree so
// @turjuman/aws-cdk is standalone-installable: the construct's Code.fromAsset resolves
// these copies (see `lambdaDir` in src/turjuman.ts) with NO runtime dependency on the
// sibling @turjuman/mcp-server / @turjuman/api packages. Runs after `tsc`, as part of
// `pnpm run build`. The source bundles are produced by those packages' own
// build-lambda.mjs, which pnpm's dependency-ordered build runs first.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(pkgRoot, "..");

// destination subdir -> { source bundle dir, the entry file that must exist }
const bundles = [
	{
		sub: "mcp",
		from: join(packagesDir, "mcp-server", "lambda"),
		entry: "handler.mjs",
	},
	{
		sub: "api",
		from: join(packagesDir, "api", "lambda"),
		entry: "handler.mjs",
	},
	{
		sub: "webhook",
		from: join(packagesDir, "api", "lambda-webhook"),
		entry: "webhook.mjs",
	},
];

for (const b of bundles) {
	const entryPath = join(b.from, b.entry);
	if (!existsSync(entryPath)) {
		throw new Error(
			`Missing Lambda bundle ${entryPath}. Build the source packages first ` +
				"(`pnpm run build` builds @turjuman/mcp-server and @turjuman/api before this package).",
		);
	}
	const dest = join(pkgRoot, "lambda", b.sub);
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	// Copies the bundle (.mjs) + its {"type":"module"} package.json companion.
	cpSync(b.from, dest, { recursive: true });
	console.log(`Vendored ${b.from} -> lambda/${b.sub}`);
}
