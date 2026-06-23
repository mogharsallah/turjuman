#!/usr/bin/env node
// esbuild the Lambda handler into a self-contained ESM asset dir (lambda/) that the
// construct ships via Code.fromAsset. Run after `tsc`. bundle({ watch }) powers the
// dev hot-reload loop: watch mode aliases @turjuman/* to `src` (no prior tsc); the
// default build resolves `dist` as `pnpm run build`/CI expect.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");

// createRequire shim so bundled CJS deps can require() Node built-ins on Lambda.
const banner =
  "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

const targets = [{ entry: "src/handler.ts", dir: "lambda", outFile: "handler.mjs" }];

// Dev-only: resolve @turjuman/* to source so a watch rebuilds on cross-package edits.
const srcAlias = {
  "@turjuman/core": join(repoRoot, "packages/core/src/index.ts"),
  "@turjuman/schema": join(repoRoot, "packages/schema/src/index.ts"),
  "@turjuman/schema/qa": join(repoRoot, "packages/schema/src/qa/index.ts"),
  "@turjuman/formats": join(repoRoot, "packages/formats/src/index.ts"),
};

// Bundle every target; watch mode aliases to src, builds once, then rebuilds on change.
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
      target: "node24",
      banner: { js: banner },
      ...(watch ? { alias: srcAlias } : {}),
    };
    writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n'); // mark ESM asset
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
