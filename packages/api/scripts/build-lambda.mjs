#!/usr/bin/env node
// Bundle the REST + webhook Lambda handlers into self-contained ESM asset
// directories that the @turjuman/aws-cdk construct ships to Lambda via
// Code.fromAsset. esbuild inlines the whole dependency graph (including
// @turjuman/core/@turjuman/formats), so each asset needs nothing at runtime but
// the Node 20 Lambda runtime. Run after `tsc` (see the package `build` script).
//
// Two directories because Code.fromAsset hashes/zips a whole directory — keeping
// each bundle alone (handler vs. webhook) makes each asset minimal and stable.
//
// Exposes bundle({ watch }) for the dev hot-reload loop (scripts/dev-lambda.mjs):
// in watch mode it aliases the workspace packages to their `src` so cross-package
// edits rebundle without a prior `tsc`. The default (non-watch) build is
// unchanged — it resolves the built `dist`, as `npm run build` and CI expect.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");

// createRequire shim so a CJS dependency bundled into the ESM output can still
// `require()` Node built-ins under the Lambda runtime.
const banner =
  "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

/** One esbuild bundle per asset directory. */
const targets = [
  { entry: "src/handler.ts", dir: "lambda", outFile: "handler.mjs" },
  { entry: "src/webhook.ts", dir: "lambda-webhook", outFile: "webhook.mjs" },
];

/** Dev-only: resolve @turjuman/* to source so a watch rebuilds on cross-package edits. */
const srcAlias = {
  "@turjuman/core": join(repoRoot, "packages/core/src/index.ts"),
  "@turjuman/schema": join(repoRoot, "packages/schema/src/index.ts"),
  "@turjuman/schema/qa": join(repoRoot, "packages/schema/src/qa/index.ts"),
  "@turjuman/formats": join(repoRoot, "packages/formats/src/index.ts"),
};

/**
 * Bundle every target. With `watch: true`, aliases workspace packages to `src`,
 * performs an initial build, then keeps rebuilding on change; returns the esbuild
 * contexts so the caller can keep the process alive / dispose them.
 */
export async function bundle({ watch = false } = {}) {
  const contexts = [];
  for (const t of targets) {
    const outDir = join(pkgRoot, t.dir);
    if (!watch) rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const options = {
      entryPoints: [join(pkgRoot, t.entry)],
      outfile: join(outDir, t.outFile),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      banner: { js: banner },
      ...(watch ? { alias: srcAlias } : {}),
    };
    // Mark the asset as an ES module (belt-and-suspenders next to the .mjs handler).
    writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');
    if (watch) {
      const ctx = await esbuild.context(options);
      await ctx.rebuild(); // guarantee an initial bundle before the caller deploys
      await ctx.watch();
      contexts.push(ctx);
    } else {
      await esbuild.build(options);
    }
    console.log(`Bundled ${t.entry} -> ${t.dir}/${t.outFile}${watch ? " (watching)" : ""}`);
  }
  return contexts;
}

/** CLI entry: `node scripts/build-lambda.mjs [--watch]`. */
if (import.meta.url === `file://${process.argv[1]}`) {
  await bundle({ watch: process.argv.includes("--watch") });
}
