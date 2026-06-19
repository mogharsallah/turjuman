#!/usr/bin/env node
// Bundle the Lambda handler into a self-contained ESM asset directory that the
// @turjuman/aws-cdk construct ships to Lambda via Code.fromAsset. esbuild inlines
// the whole dependency graph (including @turjuman/core, which re-exports
// @turjuman/schema), so the asset needs nothing at runtime but the Node 20 Lambda
// runtime. Run after `tsc` (see the package `build` script).
//
// Output: lambda/{handler.mjs, package.json} — one clean directory so the
// construct's Code.fromAsset hashes/zips exactly this bundle and nothing else.
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
const targets = [{ entry: "src/handler.ts", dir: "lambda", outFile: "handler.mjs" }];

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
