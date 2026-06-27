# Element → docs map, docs structure, and how to keep both current (Turjuman)

This is the **single authoritative** answer to three questions: *which doc page does a code change
touch?*, *how is `docs/` structured and where does a new page go?*, and *how do I keep this file from
rotting?* `SKILL.md` only carries the one-line principle and points here — don't duplicate the table
back into it.

## The durable principle (lead with this)

Turjuman has one brain (`@turjuman/core`) exposed through one transport-agnostic **operation layer**
(`@turjuman/sdk`). A capability is declared **once** as an `Operation` and projected to *both* the MCP
tool surface and (via its `http` binding) the REST route. Therefore:

- **Document a capability once, at the reference level** — not as a separate "MCP tool" and "REST
  route." There is no `mcp-server/src/tools/` directory.
- **The REST endpoint page is auto-generated** from the operation's `http` binding via the OpenAPI
  snapshot — never hand-write endpoint pages (see `SKILL.md` → OpenAPI).
- **Concepts explain, references list, guides walk through** — route the change to the page whose *job*
  matches (see `doc-types.md`).

If the paths in the table below have moved, the principle still holds — fix the rows (see *Keeping this
current*).

## The change → page table (a convenience over the principle)

| You changed (source) | Update (docs) |
|---|---|
| A **capability**: a service in `packages/core/src/services/` + its `Operation` in `packages/sdk/src/operations/` | `reference/mcp-tools.mdx` (row in the right group) + a workflow in `guides/translate-with-mcp.mdx` (and `guides/code-mode.mdx`) if it enables a new task. REST page auto-generated from the `http` binding. Use the operation name **verbatim**. |
| A **CLI command or flag** (`packages/cli/src/`, commands in `src/commands/`) | `reference/cli-commands.mdx` (+ `guides/sync-with-cli.mdx` if the workflow changed; + `self-hosting.mdx` for deploy/teardown/status) |
| A **file-format adapter** (`packages/formats/src/`, `ADAPTERS` in `formats/src/index.ts`) | `reference/file-formats.mdx` |
| A **QA check** (`packages/schema/src/qa/checks/`, `CHECKS` in `qa/index.ts`) | `reference/qa-checks.mdx` (catalogue row + any limit); `guides/quality-checks.mdx` only if behaviour changed |
| A **data-model / schema field** (`packages/schema/src/domain.ts`; repository in `packages/core/src/repository/`) | `concepts/architecture.mdx`; + `concepts/lifecycle.mdx` if it's lifecycle state (status, slots, `origin`, `stale`, `state`) |
| **RBAC / permissions** (`packages/schema/src/rbac.ts`) | `concepts/roles-and-permissions.mdx` |
| **CDK construct / deploy** (`packages/aws-cdk/src/`, `packages/aws-deploy/src/`) | `self-hosting.mdx` |
| **Tests / tiers** (`packages/*/`, `.github/workflows/`) | `CLAUDE.md` / `TESTING.md` (no docs-site page today) |
| **Shipped/planned status** | `ROADMAP.md` at the repo root — not a docs page; refer to it in prose, don't link it |

## Docs structure (where things live, and the rationale)

`docs/` follows a Diátaxis-by-directory convention, surfaced as two `docs.json` tabs:

```
docs/
├── introduction.mdx          # landing/overview (root)
├── quickstart.mdx            # the one tutorial (root)
├── self-hosting.mdx          # deploy guide (root)
├── concepts/                 # explanation pages — the model + the why
├── guides/                   # how-to pages — task walkthroughs
├── reference/                # exhaustive catalogues — tools, CLI, formats, QA
└── api-reference/            # REST: overview.mdx + the auto-generated openapi.json
```

- **Two tabs, by audience.** **Documentation** (concepts/guides/reference — the human + agent narrative
  and catalogues) and **API Reference** (the generated REST endpoints for CLI/CI integrators). They're
  split because they're genuinely different audiences and shouldn't blend (see
  `navigation-and-settings.md`).
- **Root pages** are the few cross-cutting entry points (intro, quickstart, self-hosting); everything
  else lives under its type directory.

**Decision rule — new page vs. group vs. tab:**

1. **Does an existing page cover it?** Extend that page. Prefer this — don't spawn thin pages.
2. **New page, existing area?** Add the `.mdx` under the matching type directory and register it in the
   right `docs.json` group.
3. **New area within the same audience?** Add a new **group** to the Documentation tab (keep the tab to
   ≤7 groups; see `navigation-and-settings.md`).
4. **Genuinely distinct audience or product surface?** A new **tab**. This is rare — justify it.

Name files in kebab-case matching their nav path (`reference/mcp-tools.mdx` → `"reference/mcp-tools"`).

## Keeping this current (self-maintenance)

This file is a snapshot of the codebase, so it drifts. Two trigger points keep it honest:

- **When you use it during docs work and a path/page is wrong** — fix the offending row/section in the
  **same PR**. Don't work around a stale entry silently.
- **When you change the architecture this file describes** — a new operation group in
  `packages/sdk/src/operations/`, a new service, a relocated package, a new file format / QA check
  *category*, or a new docs area/tab — update the table, the structure tree, and the page list below in
  that same change. (`CLAUDE.md` → "Where to make changes" carries a pointer back here so a code-only
  change still prompts the update.)

Quick drift check before relying on it: confirm the source paths in the table still exist
(`packages/sdk/src/operations/`, `packages/core/src/services/`) and that the page list matches
`docs/docs.json`.

### Current docs pages (extend, don't duplicate)

`introduction` · `quickstart` · `self-hosting` · `concepts/architecture` · `concepts/lifecycle` ·
`concepts/roles-and-permissions` · `guides/translate-with-mcp` · `guides/code-mode` ·
`guides/sync-with-cli` · `guides/quality-checks` · `guides/webhooks` · `reference/mcp-tools` ·
`reference/cli-commands` · `reference/file-formats` · `reference/qa-checks` · `api-reference/overview`
(+ the auto-generated `Endpoints` group).
