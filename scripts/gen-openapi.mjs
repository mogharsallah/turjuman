#!/usr/bin/env node
// Generate the OpenAPI snapshot that Mintlify renders as the API reference.
//
// The REST API already serves its spec at GET /v1/openapi.json (hono-openapi +
// the shared zod schemas). This script builds the same Hono app in-process and
// writes the document to docs/api-reference/openapi.json — no AWS needed, since
// the OpenAPI handler only introspects route definitions (it never runs them).
//
// Run `npm run gen:openapi` after changing any REST route; CI fails if the
// committed snapshot drifts from the code.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// repositoryFromEnv() only constructs a DynamoDB client (no network until a
// call is made), and we never make one — so a placeholder table name is fine.
process.env.TURJUMAN_TABLE ??= "Turjuman";
process.env.AWS_REGION ??= "us-east-1";

const { TurjumanService, repositoryFromEnv } = await import("@turjuman/core");
const { createApp } = await import(resolve(repoRoot, "packages/api/dist/router.js"));

const repo = repositoryFromEnv();
const service = new TurjumanService(repo);
const app = createApp({ repo, service });

const res = await app.request("/v1/openapi.json");
if (!res.ok) {
  console.error(`Failed to generate OpenAPI spec: HTTP ${res.status}`);
  process.exit(1);
}
// Pure snapshot: the served document is already canonical (info/description,
// servers, security scheme all live in router.ts). This script only persists
// it as a file Mintlify can read; it does not add or rewrite anything.
const spec = await res.json();

const outDir = resolve(repoRoot, "docs/api-reference");
await mkdir(outDir, { recursive: true });
const outFile = resolve(outDir, "openapi.json");
await writeFile(outFile, JSON.stringify(spec, null, 2) + "\n");
console.log(`Wrote ${outFile} (${spec.paths ? Object.keys(spec.paths).length : 0} paths)`);
