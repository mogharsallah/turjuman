Turjuman is open-source, self-hosted translation management driven primarily through an **MCP server**
(an LLM/agent does the translating) with a thin **developer CLI** for deterministic locale-file work.
It runs serverless on AWS (Lambda Function URLs + a single DynamoDB table). Deliberate non-goals: no
web UI, no built-in machine-translation engine, no vendor marketplace (see `ROADMAP.md`).

**Follow YAGNI principles, and one-liner solutions.**

## Commands

Standard scripts (`build`, `typecheck`, `test`, `check`, `clean`, …) live in `package.json`. The
non-obvious invocations:

```bash
# Run one package, one file, or one test case (workspaces use plain `vitest run`):
pnpm --filter @turjuman/core run test                          # one package
pnpm --filter @turjuman/core run test -- services.test.ts      # one file (path substring)
pnpm --filter @turjuman/core run test -- -t "rejects a viewer" # one test by name

# LocalStack-backed tiers (need Docker); both self-skip when their env vars are unset:
pnpm run localstack:up && pnpm run test:integration && pnpm run localstack:down  # Tier A: repo+services vs real DynamoDB
pnpm run test:e2e                                                                # Tier B: deploy stack + black-box HTTP

# Single dev loop: deploy into LocalStack + esbuild --watch hot reload; prints Function URLs + a fresh API key:
pnpm run localstack:up && cp .env.example .env && pnpm run dev
```

For *how to write* tests (the independent-oracle rule, the L0–L5 layers, fakes, property tests,
determinism, coverage) read `TESTING.md`. Dev-loop / LocalStack details live in `scripts/dev.mjs`.
Gotchas worth knowing up front:

- The dev loop runs the **real** Lambda runtime (so the DynamoDB Streams → webhook path fires); the
  entrypoints are the Lambda `handler`s only — there is no `local.ts`, no `:8000`, no public ports
  (LocalStack + Function URLs are localhost-only; reach a remote box via SSH forwarding).
- One **shared** LocalStack on `:4566` serves every session; each working copy deploys its **own** dev
  stack, named from a persisted, gitignored `.turjuman-dev` marker. `dev:teardown` deletes just this
  copy's stack; `localstack:down` wipes the whole emulator and **every** session — never use it to
  clean up one session.

## Architecture

One shared brain (`@turjuman/core`) exposed through one transport-agnostic operation layer
(`@turjuman/sdk`). **All business logic and all authorization live in `core`**, and every capability
is declared once in `@turjuman/sdk` (`OPERATIONS`), so the MCP and REST surfaces can never drift.
Transports only translate HTTP ↔ operation calls — never put auth or domain logic in a transport, and
never hand-write an MCP tool or REST route that bypasses `OPERATIONS`.

| Package | Role (key file/export) |
|---|---|
| `packages/schema` | AWS-free base: domain model (`domain.ts`), `validation`, `wire` shapes, `rbac` policy, ICU plurals (`plural.ts`), QA engine (`qa/`). |
| `packages/formats` | Locale file-format adapters over a canonical ICU representation, registered in `ADAPTERS` (`src/index.ts`). |
| `packages/core` | Server core: single-table `Repository` (`repository/`) + `TurjumanService` facade over sub-services (`services/`). Only package with the AWS SDK. |
| `packages/sdk` | The operation layer — single source of capability. Each `Operation` (`src/operations/*`, via `op()`) carries zod `input`/`output`, `OpAnnotations`, optional `http` binding, and a `handler`. No MCP dep. |
| `packages/knowledge` | Orama BM25 index over SDK operations + the docs corpus; powers code mode's `search`/`describe`. No MCP/AWS dep. |
| `packages/sandbox` | Code-mode engine: `runCode(...)` runs untrusted JS/TS in a per-run QuickJS-WASM isolate whose only capability is the SDK registry. |
| `packages/mcp-server` | Stateless MCP over Streamable HTTP; tool surface is a projection of `OPERATIONS`. Modes: *classic* (default) and *code* (`?mode=code`). |
| `packages/api` | REST API (`src/router.ts`) + Streams→webhook dispatcher (`src/webhook.ts`); operation-backed routes via `projectOperation(...)`, plus bespoke CLI routes (incl. the unauthenticated first-owner `POST /v1/bootstrap`). |
| `packages/cli` | The lean `turjuman` developer CLI (commander); pure `run*` commands; no AWS SDK. |
| `packages/aws-cdk` | `@turjuman/aws-cdk` construct library: props-driven deploy topology (table + 3 GSIs + Streams + up to 3 Function URLs). Standalone-installable: vendors the 3 Lambda bundles into `lambda/` at build, so no runtime dep on mcp-server/api. |
| `packages/deploy-internal` | **Private** deploy primitives for the dev/e2e scripts: `deployStack` (`toolkit.ts`) + CloudFormation helpers (`stack.ts`). |
| `packages/e2e` | Black-box vitest specs that only talk HTTP to a deployed (LocalStack) stack. |

### Where to make changes
- **New capability / business rule** → add to the matching sub-service in `core/services/` (with its
  `rbac` check; shared helpers on `BaseService`). A brand-new domain gets its own `XService` wired
  onto the `TurjumanService` facade in `core/services/service.ts`. Then expose it by adding an
  `Operation` to the matching group in `sdk/src/operations/` — projected to an MCP tool automatically,
  and to a REST route when you give it an `http` binding. If you add an operation **group**, a service,
  or relocate a package, update `.claude/skills/writing-docs/element-map.md` in the same change.
- **Authorization** → `schema/src/rbac.ts`. Global OWNER/ADMIN/MEMBER + per-project
  MANAGER/EDITOR/DEVELOPER/VIEWER, enforced by `requireProject`/`requireOrg` before every mutating
  call. OWNER/ADMIN act as MANAGER on every project in their org.
- **New file format** → add a `FormatAdapter` under `packages/formats/src/` and register it in
  `ADAPTERS` (`formats/src/index.ts`). Plurals are stored canonically as ICU; convert via the helpers
  in `schema`'s `plural.ts`.
- **New QA check** → add a pure `QaCheck` under `packages/schema/src/qa/checks/`, register it in
  `CHECKS` (`qa/index.ts`), and cover it in `qa/checks.test.ts`. I/O/lifecycle coupling stays in
  `core/services/qa.ts`.
- **Anything user-visible** (tool/route/flag/format/check/field) → update its docs page in the same
  change (see Documentation).

### Data model (single-table DynamoDB)
One `Turjuman` table + GSI1/2/3 (all project `ALL`). Entities: `User`, `ApiKey`, `Project`, `Locale`,
`TranslationKey`, `Translation`, `Membership`, glossary terms, webhooks. Every record carries an
`orgId` (self-host defaults to a single `default` org); a translation `value` is an ICU MessageFormat
string. Email uniqueness uses a companion `USEREMAIL#` item written in the same `TransactWriteItems`.
Read `docs/concepts/architecture.mdx` (PK/SK/GSI layout) before changing `repository/repository.ts`.

## Conventions & gotchas

- **ESM + NodeNext.** `"type": "module"` everywhere; relative imports need explicit `.js` extensions.
  TS is strict, with `noUncheckedIndexedAccess` and `noImplicitOverride` (`tsconfig.base.json`).
- **Dependents import core's built `dist`, not its source.** `build` is dependency-ordered (core
  first); after editing `core`, run `pnpm run build` (or at least build core) before the typecheck or
  tests of `mcp-server`/`api`/`cli`/`e2e` see the change. Core's own tests run against source.
- **Integration/e2e suites self-skip** when their endpoint env vars are unset — keep them that way so
  `pnpm test` stays hermetic.
- **Biome owns formatting + linting** (`biome.json`: tabs, double quotes, 80-col). The
  `.claude/hooks/biome-format.sh` PostToolUse hook auto-formats every file you edit — don't hand-fix
  style.
- **Node ≥ 24**, Lambda runtime `nodejs24.x`, default arch `arm64`.
- Treat any **Mintlify** PR check failure (preview deploy / docs build) as non-blocking — note it,
  don't try to fix it.

## Security

Static `Authorization: Bearer <api-key>` on every request; keys are stored as a SHA-256 hash and
resolved by `authenticate()` in core. Lambda Function URLs use `AuthType: NONE` **by design** —
Turjuman validates its own keys (no API Gateway, no Cognito). Never commit `.env` or real credentials
(`.env.example` ships dummy creds only); the `.turjuman-dev` marker is gitignored.

## Documentation

The docs in `docs/` are the **single source of truth**, published as a Mintlify site — one source
serves humans, agents (`llms.txt` + per-page `.md`), and you; there is no separate agent doc.

- **Update docs in the same change as the code.** A new operation/tool, CLI flag, format adapter, QA
  check, service, or schema field isn't done until its page is updated.
- **Use the `writing-docs` skill** for all docs work — it's the source of truth for Mintlify craft,
  the code→docs map (`element-map.md`), and content vs. structural changes.
- **REST endpoint pages are auto-generated, never hand-written.** Annotate each route with
  `describeRoute({ summary, tags, ... })`; the pre-commit hook regenerates `openapi.json` and CI
  fails on drift.
