# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Turjuman is open-source, self-hosted translation management driven primarily through an **MCP
server** (an LLM/agent does the translating) with a thin **developer CLI** for deterministic
locale-file work. It runs serverless on AWS (Lambda Function URLs + a single DynamoDB table); there
is no web UI and no built-in machine-translation engine — both are deliberate non-goals (see
`ROADMAP.md`).

## Commands

```bash
pnpm run build          # builds every workspace in dependency order (core first)
pnpm run typecheck      # tsc --noEmit across workspaces
pnpm run test           # == test:unit — hermetic unit tests (integration/e2e self-skip)
pnpm run clean
```

Run one package's tests, or one file/case (workspaces use plain `vitest run`):

```bash
pnpm --filter @turjuman/core run test                          # one package
pnpm --filter @turjuman/core run test -- services.test.ts      # one file (path substring)
pnpm --filter @turjuman/core run test -- -t "rejects a viewer" # one test by name
```

LocalStack-backed tests (need Docker; see `docs/contributing.mdx`):

```bash
pnpm run localstack:up && pnpm run test:integration && pnpm run localstack:down   # Tier A: repo+services vs real DynamoDB
pnpm run test:e2e                                                               # Tier B: deploy SAM stack + black-box HTTP e2e
```

These tiers (and the DynamoDB-Local flow below) need a working Docker daemon, and the suites
self-skip when their endpoint env vars are unset. You can also rely on GitHub Actions: every PR runs
`build + typecheck + unit`, `docs link check`, and `integration + deployed e2e (LocalStack)` — the
last is Tier A + Tier B end-to-end. Push the branch / open the PR and read those check results as the
source of truth for end-to-end verification.

Local dev loop — everything runs against the **shared LocalStack** (the same `:4566` service the test
tiers use); there is no more `amazon/dynamodb-local` / `:8000` path:

```bash
pnpm run localstack:up                         # shared LocalStack on :4566 (+ health wait)
cp .env.example .env                          # AWS_ENDPOINT_URL=http://localhost:4566, dummy creds
pnpm run dev                                   # deploy into LocalStack + hot reload; prints URLs + API key
```

`pnpm run dev` (`scripts/dev.mjs`) is the single dev loop: `esbuild --watch` over the three Lambda
bundles + the `@turjuman/aws-cdk` construct deployed into LocalStack with its dev-only `hotReload` prop,
so each save is served on the next invoke without a redeploy. It runs the **real** Lambda runtime (so
the DynamoDB Streams → webhook path fires), and it bootstraps an owner and prints the MCP/REST Function
URLs + a fresh API key every run. `pnpm run dev:deploy` redeploys once after an infra change (grants,
event sources, env). There is no `local.ts` and no `tsx`/localhost-server loop — the entrypoints are the
Lambda `handler`s only.

**Script naming (no aliases):** `localstack:up`/`localstack:down` manage the **shared emulator
container** (Docker); `dev`/`dev:deploy`/`dev:teardown` act on **this working copy's CloudFormation
stack** only. A `*:teardown` always deletes a CFN stack; `localstack:down` (= `docker compose down -v`)
wipes the whole emulator and every session's stack — never use it to clean up one session.

**Parallel sessions on one LocalStack:** each working copy (git worktree or separate clone) deploys its
**own** dev stack, named from a persisted, gitignored `.turjuman-dev` marker (`turjuman-dev-<hex>`,
generated on first `pnpm run dev` by `scripts/dev-stack.mjs`). Because every dev AWS resource name derives
from that stack name (table, the three Lambdas + Function URLs, SSM config path, log groups), distinct
markers isolate sessions automatically — many can share the one `:4566` LocalStack without colliding.
`TURJUMAN_DEV_STACK` overrides the marker; `pnpm run dev:teardown` deletes just this working copy's stack
(`rm .turjuman-dev` to get a fresh identity).

Notes for future sessions: never reintroduce `:8000`, `local.ts`, the
`dev-serve.ts` harness, or public ports — LocalStack and the Function URLs are localhost-only (reach a
remote box via SSH forwarding). Use the global `AWS_ENDPOINT_URL` (not per-service vars); the dev stack's
table is separate from the integration tier's `TurjumanIntegration`. Remote/contributor setup:
`scripts/provision-dev.sh` (SSH boxes) and `.devcontainer/` (Codespaces, docker-outside-of-docker).

## Architecture

One shared brain (`@turjuman/core`) exposed through one transport-agnostic operation layer
(`@turjuman/sdk`) that the transports project. The transports only translate HTTP ↔ operation calls —
**all business logic and all authorization live in `core`**, and every capability is declared once in
`@turjuman/sdk` (`OPERATIONS`), so the MCP and REST surfaces can never drift in behaviour or
permissions. The MCP server is a thin projection of `OPERATIONS` (classic mode registers each as a
tool); the REST API is being migrated to the same projection (see `adr/0001-code-mode-mcp.md`).

```
Claude Code / agent ──Streamable HTTP + Bearer key──► McpFunction ─┐
Developer CLI / CI ──REST + Bearer key──────────────► ApiFunction ─┤──► @turjuman/core ──► DynamoDB
                                          DynamoDB Streams ─────────┴──► WebhookFunction (HMAC POSTs)
```

| Package | Role |
|---|---|
| `packages/schema` | The pure, **AWS-free** base everything builds on: the domain model (zod schemas + inferred types in `domain.ts`), input `validation`, transport `wire` shapes, the `rbac` policy + enforcement, ICU plural helpers (`plural.ts`), and the QA check engine (`qa/`, also at the `@turjuman/schema/qa` subpath). No AWS SDK — so the CLI can depend on it without server weight. |
| `packages/formats` | The localization file-format adapters (JSON/YAML/`.properties`/ARB/CSV/Android/iOS/gettext PO/XLIFF 1.2/2.0), each implementing `FormatAdapter` over a canonical ICU representation. Registered in the `ADAPTERS` array in `src/index.ts`. Depends on `@turjuman/schema` (for plurals); used by the CLI and the REST `/v1/formats` endpoint. |
| `packages/core` | Server core: the single-table DynamoDB `Repository` (class in `repository/`, with PK/SK builders + item mappers split out) and `TurjumanService` (a facade over per-domain sub-services in `services/`, sharing `BaseService`). Built on `@turjuman/schema`, which it re-exports so server-side consumers import everything from `@turjuman/core`. The only package with the AWS SDK at its core. |
| `packages/sdk` | The transport-agnostic **operation layer** — the single source of capability. Each `Operation` (in `src/operations/*`, authored via the `op()` factory in `src/base.ts`) carries a zod `input`/`output`, a description, MCP-free behaviour hints (`OpAnnotations`), an optional `http` binding (for the REST projection), and a `handler(args, ctx) => service.X(...)`. Exports `OPERATIONS`, `OPERATIONS_BY_NAME`, `OPERATION_GROUPS`, the `OpContext` type, and introspection helpers (`effectiveAnnotations`/`searchOperations`/`operationsMissingHttp` in `src/signatures.ts`). Depends on `@turjuman/core` + `zod` only — **no `@modelcontextprotocol/sdk`** — so MCP, REST, and the sandbox can all project from it without coupling. |
| `packages/sandbox` | The code-mode execution engine: `runCode({ code, ctx, limits })` runs untrusted JS/TS in a per-run **QuickJS-WASM** isolate whose only capability is the `@turjuman/sdk` registry, reached via an in-process host broker (`createOpDispatcher`). The guest sees `turjuman.<operation>(args)` (generated stubs) + `console` and nothing else — no network/fs/env/timers. Uses the synchronous QuickJS context + deferred-promise bridge (asyncify is too fragile for our needs); each run gets a fresh WASM module so a timed-out run is abandoned cleanly. Bounds CPU/memory/output/op-count. Depends on `@turjuman/sdk` + `@turjuman/core` + `quickjs-emscripten`. |
| `packages/mcp-server` | Stateless MCP over Streamable HTTP (one POST = one JSON-RPC message). Lambda handler in `src/handler.ts`; the tool surface is a **projection of `@turjuman/sdk`'s `OPERATIONS`** (no hand-kept tool array — `protocol.ts` registers each operation; `scope.ts` does URL tool-scoping). `pnpm run build` also esbuild-bundles a self-contained `lambda/handler.mjs` asset (via `scripts/build-lambda.mjs`) that `@turjuman/aws-cdk` ships with `Code.fromAsset`. |
| `packages/api` | REST API for the CLI/CI (`src/router.ts`) + the Streams→webhook dispatcher (`src/webhook.ts`). Also ships pre-bundled `lambda/handler.mjs` + `lambda-webhook/webhook.mjs` assets (see `scripts/build-lambda.mjs`). |
| `packages/cli` | The lean `turjuman` developer CLI: thin `bin` (`src/index.ts`) over `src/program.ts` (commander) + per-command modules in `src/commands/`. Each command is a pure `run*` function (testable with a fake `ApiClient` + `OutputSink`) behind a thin `register*`. `src/client.ts` types request bodies off `@turjuman/schema`'s zod schemas; `src/output.ts` drives the `--json` mode; auth lives in `src/auth.ts` (published as `@turjuman/cli/auth`). Depends only on `commander`, `@turjuman/formats`, `@turjuman/schema`, `zod` — **no AWS SDK**. |
| `packages/aws-cdk` | The `@turjuman/aws-cdk` construct library (lightweight, peer-dep on `aws-cdk-lib`): `Turjuman extends Construct` + a thin `TurjumanStack` wrapper + props, in `src/`. The single, props-driven source of the deploy topology (DynamoDB on-demand/provisioned, 3 GSIs, Streams, RETAIN + optional PITR/deletion-protection, + up to three Lambda Function URLs with api/webhook toggles). Default synthesizer (standard bootstrap); default Lambda `Code` resolves the pre-bundled `@turjuman/mcp-server`/`@turjuman/api` assets. `synthTemplate` exposes the template for tests. |
| `packages/aws-deploy` | The self-host tooling (`turjuman-aws-deploy` bin, `src/main.ts`): a thin AWS deploy CLI over the `@turjuman/aws-cdk` construct. `src/toolkit.ts` self-bootstraps (idempotent) then deploys via the CDK programmatic toolkit; `src/config.ts` is a zod-schema config (v2) with the canonical copy in SSM (`src/ssm-config.ts`, `/turjuman/<stack>/deploy-config`) and `turjuman.deploy.json` as a local cache; `mapConfigToProps`/`applyOverrides` drive props and `--set`/`--enable`/`--disable`. Reuses `@turjuman/cli/auth` to write/remove credentials. |
| `packages/e2e` | Black-box vitest specs that only talk HTTP to a deployed (LocalStack) stack. |
| `packages/aws-cdk/src/turjuman.ts` | The `Turjuman` construct: DynamoDB single table + GSI1/2/3 + Streams (RETAIN) and the MCP/API/webhook Lambda Function URLs. Idiomatic logical ids except the deliberately-fixed, retained table. |

### Where to make changes
- **New capability / business rule** → add it to the matching domain sub-service in
  `core/services/` (e.g. `core/services/keys.ts`, with its `rbac` check; shared auth/provision
  helpers live on `BaseService`). A brand-new domain gets its own `XService` wired onto the
  `TurjumanService` facade in `core/services/service.ts`. Then expose it by adding an `Operation` to
  the matching group in `sdk/src/operations/` (`@turjuman/sdk`) — that one definition is projected to
  an MCP tool automatically, and to a REST route when you give it an `http` binding. Never put
  authorization or domain logic in a transport, and never hand-write an MCP tool or REST route that
  bypasses `OPERATIONS`.
- **Authorization** → `schema/src/rbac.ts` (in `@turjuman/core`'s `@turjuman/schema` base). The matrix
  (global OWNER/ADMIN/MEMBER + per-project MANAGER/EDITOR/DEVELOPER/VIEWER) is enforced by
  `requireProject` / `requireOrg` before every mutating service call. OWNER/ADMIN act as MANAGER on
  every project in their org.
- **New file format** → add an adapter under `packages/formats/src/` implementing `FormatAdapter` and
  register it in the `ADAPTERS` array in `formats/src/index.ts` (`@turjuman/formats`). Plurals are stored
  canonically as ICU MessageFormat; adapters convert to/from each format's native plural form using
  the helpers in `@turjuman/schema`'s `plural.ts`.
- **New QA check** → add a pure `QaCheck` under `packages/schema/src/qa/checks/`, register it in the
  `CHECKS` array in `qa/index.ts` (`@turjuman/schema`), and cover it in `qa/checks.test.ts`. Checks are
  pure functions over a `QaContext`; all I/O and lifecycle coupling live in `core/services/qa.ts` (the
  single seam). See `docs/reference/qa-checks.mdx`.
- **Anything user-visible (new tool/route/flag/format/check/field)** → also update its docs page in the
  same change (see the Documentation section).

### Data model (single-table DynamoDB)
One table (`Turjuman`) with GSI1/2/3 (all project `ALL`). Entities: `User`, `ApiKey`, `Project`,
`Locale`, `TranslationKey`, `Translation`, `Membership`, glossary terms, webhooks. Every record
carries an `orgId` (multi-tenant ready; self-host defaults to a single `default` org). A translation
`value` is an ICU MessageFormat string. Key access patterns and the exact PK/SK/GSI layout are in
`docs/concepts/architecture.mdx` — read it before changing `repository/repository.ts`. Email uniqueness is enforced via a
companion `USEREMAIL#` item written in the same `TransactWriteItems` as the user.

### Auth
Static `Authorization: Bearer <api-key>` on every request; keys are stored as a SHA-256 hash and
resolved by `authenticate()` in core. Lambda Function URLs use `AuthType: NONE` because Turjuman
validates its own keys (no API Gateway, no Cognito).

## Conventions & gotchas

- **ESM + NodeNext.** `"type": "module"` everywhere; relative imports must use explicit `.js`
  extensions (e.g. `import { x } from "./foo.js"`). TypeScript config is strict, with
  `noUncheckedIndexedAccess` and `noImplicitOverride` (`tsconfig.base.json`).
- **Dependents import core's built `dist`, not its source** (`@turjuman/core` → `./dist/index.js`).
  After editing `core`, run `pnpm run build` (or at least build core) before the typecheck or tests of
  `mcp-server`/`api`/`cli`/`e2e` will see the change. Core's own vitest tests run against source and
  don't need a build.
- **Integration/e2e suites self-skip** when their endpoint env vars are unset, which keeps the
  default `pnpm test` hermetic. Don't make them run unconditionally. When Docker is available you can
  run the LocalStack tiers locally; otherwise verify end-to-end work through the GitHub Actions
  checks on the PR.
- **Node ≥ 24**, Lambda runtime `nodejs24.x`, default arch `arm64` (the e2e deploy overrides to match
  the host so functions run natively under LocalStack).
- Keep the MCP-first / developer-first scope: no web UI, no MT engine, no vendor marketplace (see
  ROADMAP "Explicitly out of scope").
- **When checking PR / GitHub Actions status, treat any Mintlify check failure (e.g. the preview
  deployment or docs build) as non-blocking** — note it but don't treat it as a real CI failure or
  try to fix it.

## Documentation

The docs in `docs/` are the **single source of truth**, published as a Mintlify site (`docs/docs.json`
defines the structure and is the Mintlify content root). One source serves three audiences: human
readers (the site), external agents (Mintlify auto-generates `llms.txt`/`llms-full.txt` and a per-page
"open in Claude/ChatGPT" menu), and you. **There is no separate agent doc** — so keep these accurate.

- **At the end of a task, suggest updating the docs.** When you finish a feature, refactor, or other
  piece of work and it's working, use your judgment — if anything user-visible changed, suggest (in a
  line or two) updating the docs via the `writing-docs` skill before wrapping up.
- **Update docs in the same change as the code.** A new MCP tool, REST route, CLI flag, format
  adapter, QA check, service, or schema field is not done until its page is updated.
- **Use the `writing-docs` skill** (`.claude/skills/writing-docs/`) when adding or revising a page —
  it encodes the Mintlify conventions (frontmatter, components) and which Diátaxis page type each
  project element belongs to.
- Author pages as `.mdx` with `title` + `description` frontmatter (the description feeds `llms.txt`);
  keep the body mostly plain Markdown so it reads cleanly in-repo too. New pages must be added to the
  `navigation` in `docs/docs.json` to appear on the site.
- **The REST API reference is auto-generated** from the OpenAPI spec the API serves at
  `GET /v1/openapi.json`. Annotate every route with `describeRoute({ summary, tags, ... })` so it
  appears in the spec; the committed snapshot `docs/api-reference/openapi.json` (which Mintlify
  renders) is refreshed by `pnpm run gen:openapi`. A **pre-commit hook** (`.githooks/pre-commit`,
  installed by `pnpm install` via the `prepare` script) rebuilds + regenerates + stages it
  automatically whenever API/core source is staged, so you rarely run it by hand; CI also fails on
  drift. Never hand-write endpoint pages.

Docs map (in `docs/`, all published): `index.mdx` (intro) · `quickstart.mdx` (run locally) ·
`self-hosting.mdx` (deploy) · `concepts/architecture.mdx` (data model, single-table, request flow) ·
`concepts/roles-and-permissions.mdx` (RBAC) · `concepts/lifecycle.mdx` (the usage lifecycle: stages,
key/translation state model, dual-slot delivery) · `guides/translate-with-mcp.mdx` ·
`guides/sync-with-cli.mdx` · `guides/quality-checks.mdx` · `guides/webhooks.mdx` ·
`reference/mcp-tools.mdx` · `reference/cli-commands.mdx` (commands, multi-target config, push/pull
semantics) · `reference/file-formats.mdx` · `reference/qa-checks.mdx` (the QA check catalogue, config,
surfaces) · `contributing.mdx` (the three test tiers + where to make changes). Plus `ROADMAP.md`
(what's built / what's next) at the repo root.
