# Element → docs map (Turjuman)

When you change code, this is the page (or pages) that must change with it, **in the same PR**. Source
locations are relative to the repo root; doc pages are under `docs/`.

> **Architecture reminder.** Turjuman has one brain (`@turjuman/core`) exposed through one
> transport-agnostic **operation layer** (`@turjuman/sdk`). A capability is declared **once** as an
> `Operation` in `packages/sdk/src/operations/*` and projected to *both* the MCP tool surface and (via
> its `http` binding) the REST API. So you document a capability at the operation/reference level — you
> do **not** document "the MCP tool" and "the REST route" as separate features. There is no
> `mcp-server/src/tools/` directory anymore.

## Capabilities / surfaces

- **A new or changed capability** — a service method in `packages/core/src/services/` (e.g.
  `services/keys.ts`, with its `rbac` check) **plus** its `Operation` in `packages/sdk/src/operations/`
  (the matching group: `projects.ts`, `keys.ts`, `translations.ts`, `glossary.ts`, `qa.ts`,
  `lifecycle.ts`, `scoring.ts`, `admin.ts`):
  → `reference/mcp-tools.mdx`: add/update the row in the right group (Projects & locales, Keys,
    Translations, Glossary & memory, Quality, Webhooks & lifecycle, Administration). Use the operation
    name **verbatim** from `sdk/src/operations/`.
  → if it unlocks a new *task*, add or update a workflow in `guides/translate-with-mcp.mdx` (and
    `guides/code-mode.mdx` if it changes the `search`/`describe`/`run_code` story).
  → the **REST route + its API-reference page are auto-generated** from the operation's `http` binding
    via the OpenAPI snapshot — don't hand-write endpoint pages (see `SKILL.md` → OpenAPI). For a
    CLI-specific bespoke route, also annotate it with `describeRoute(...)`.

- **CLI command or flag** (`packages/cli/src/`, commands in `src/commands/`)
  → `reference/cli-commands.mdx`: the command table and/or the multi-target config section.
  → `guides/sync-with-cli.mdx` if it changes the push/pull workflow or the CI gate.
  → `self-hosting.mdx` too if it's a deploy/teardown/status change.

## Core domain

- **File-format adapter** (`packages/formats/src/`, `ADAPTERS` in `formats/src/index.ts`)
  → `reference/file-formats.mdx`: the supported-formats table and any plural/description note.

- **QA check** (`packages/schema/src/qa/checks/`, `CHECKS` in `qa/index.ts`)
  → `reference/qa-checks.mdx`: a catalogue row (id, default severity, what it catches) and any
    deliberate limit. Mention config knobs in `guides/quality-checks.mdx` only if behaviour changed.

- **Data-model / schema field** (`packages/schema/src/domain.ts`; repository in
  `packages/core/src/repository/`)
  → `concepts/architecture.mdx` (domain model + single-table layout).
  → `concepts/lifecycle.mdx` if the field is part of the key/translation state model (status, slots,
    `origin`, `stale`, `state`).

- **RBAC / permissions** (`packages/schema/src/rbac.ts`)
  → `concepts/roles-and-permissions.mdx`: the matrix and the role→lifecycle table.

## Infra / ops

- **CDK construct / deploy** (`packages/aws-cdk/src/`, `packages/aws-deploy/src/`)
  → `self-hosting.mdx` (deploy, options, cost, teardown).

- **Tests / tiers** (`packages/*/`, `.github/workflows/`)
  → `contributing.mdx` lives in the repo docs set if present; otherwise the testing tiers are described
    in `CLAUDE.md` and `TESTING.md` — keep those consistent.

## Roadmap

- **Shipped/planned status** → `ROADMAP.md` at the repo root (not a docs page; refer to it in prose,
  don't link it).

## Current docs pages (so you extend rather than duplicate)

`introduction` · `quickstart` · `self-hosting` · `concepts/architecture` · `concepts/lifecycle` ·
`concepts/roles-and-permissions` · `guides/translate-with-mcp` · `guides/code-mode` ·
`guides/sync-with-cli` · `guides/quality-checks` · `guides/webhooks` · `reference/mcp-tools` ·
`reference/cli-commands` · `reference/file-formats` · `reference/qa-checks` · `api-reference/overview`
(+ the auto-generated `Endpoints` group).
