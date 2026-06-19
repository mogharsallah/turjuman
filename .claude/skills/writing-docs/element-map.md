# Element → docs map

When you change code, this is the page (or pages) that must change with it. Source locations are
relative to the repo root; doc pages are under `docs/`.

## Transports / surfaces

- **MCP tool** added/changed/removed (`packages/mcp-server/src/tools/`)
  → `reference/mcp-tools.mdx`: add/update the row in the right group (Projects & locales, Keys,
    Translations, Glossary & memory, Quality, Webhooks & lifecycle, Administration).
  → if it unlocks a new *task*, add or update a workflow in `guides/translate-with-mcp.mdx`.
  → verify the tool name verbatim against `tools/index.ts`.

- **REST route** added/changed (`packages/api/src/router.ts`)
  → annotate the route with `describeRoute({ summary, tags, parameters, responses })` so it lands in
    the OpenAPI spec. The `.githooks/pre-commit` hook refreshes + stages
    `docs/api-reference/openapi.json` on commit (or run `npm run gen:openapi`). Mintlify
    auto-generates the endpoint page + playground from that snapshot — **do not** hand-write endpoint
    pages. CI fails if the committed snapshot drifts from the code.
  → also update the "Surfaces" table on the relevant reference page (e.g. `reference/qa-checks.mdx`)
    and `guides/sync-with-cli.mdx` if the CLI workflow changed.

- **CLI command or flag** (`packages/cli/src/`)
  → `reference/cli-commands.mdx`: the command table and/or the config section.
  → `guides/sync-with-cli.mdx` if it changes the push/pull workflow or CI gate.
  → if it's a deploy/teardown/status change, `self-hosting.mdx` too.

## Core domain

- **File-format adapter** (`packages/formats/src/`, `ADAPTERS` in `formats/src/index.ts`)
  → `reference/file-formats.mdx`: the supported-formats table and any plural/description note.

- **QA check** (`packages/schema/src/qa/checks/`, `CHECKS` in `qa/index.ts`)
  → `reference/qa-checks.mdx`: a catalogue row (id, default severity, what it catches) and any
    deliberate limit. Mention config knobs in `guides/quality-checks.mdx` only if behaviour changed.

- **New service / capability** (`packages/core/src/services/`)
  → usually a new Guide (the task) and a new Reference surface; add both to `docs/docs.json`. Add a
    Concept page only if there's a non-obvious model to explain.

- **Data-model / schema field** (`packages/schema/src/domain.ts`; repository in `packages/core/src/repository/`)
  → `concepts/architecture.mdx` (domain model + single-table tables).
  → `concepts/lifecycle.mdx` if the field is part of the key/translation state model (status, slots,
    `origin`, `stale`, `state`).

- **RBAC / permissions** (`packages/schema/src/rbac.ts`)
  → `concepts/roles-and-permissions.mdx`: the matrix and the role→lifecycle table.

## Infra / ops

- **CDK stack / deploy** (`packages/deploy/src/`, `turjuman-deploy` bin)
  → `self-hosting.mdx` (deploy, options, cost, teardown).

- **Tests / tiers** (`packages/*/`, `.github/workflows/`)
  → `contributing.mdx` (testing tiers).

## Roadmap

- **Shipped/planned status** → `ROADMAP.md` at the repo root (not a docs page).
