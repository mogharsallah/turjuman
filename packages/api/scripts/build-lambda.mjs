#!/usr/bin/env node
// Bundle the REST + webhook Lambda handlers into self-contained ESM asset
// directories that the @turjuman/aws-cdk construct ships to Lambda via
// Code.fromAsset. esbuild inlines the whole dependency graph (including
// @turjuman/core/@turjuman/formats), so each asset needs nothing at runtime but
// the Node 20 Lambda runtime. Run after `tsc` (see the package `build` script).
//
// Two directories because Code.fromAsset hashes/zips a whole directory — keeping
// each bundle alone (handler vs. webhook) makes each asset minimal and stable.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// createRequire shim so a CJS dependency bundled into the ESM output can still
// `require()` Node built-ins under the Lambda runtime.
const banner =
  "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

/** One esbuild bundle per asset directory. */
const targets = [
  { entry: "src/handler.ts", dir: "lambda", outFile: "handler.mjs" },
  { entry: "src/webhook.ts", dir: "lambda-webhook", outFile: "webhook.mjs" },
];

for (const t of targets) {
  const outDir = join(pkgRoot, t.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [join(pkgRoot, t.entry)],
    outfile: join(outDir, t.outFile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    banner: { js: banner },
  });
  // Mark the asset as an ES module (belt-and-suspenders next to the .mjs handler).
  writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');
  console.log(`Bundled ${t.entry} -> ${t.dir}/${t.outFile}`);
}
