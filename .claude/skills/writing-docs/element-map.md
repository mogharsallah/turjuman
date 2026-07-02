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

## First decide: content change or structural change?

These are two different jobs with different workflows and different "done." Decide before you start —
treating a structural change as a content one is the classic failure.

- **Content change** — the docs *shape* stays the same; you edit the page that already documents the
  thing (a row, a table, a field). Use the **change → page table** below. *Most code changes are this.*
- **Structural change** — the docs *shape itself* must change: a **new page**, a **new group or tab**,
  or **splitting / moving / renaming / removing** pages. Use the **decision rule** and the **ripple
  checklist** under *Structural changes*.

Rule of thumb: another operation in an existing group → content (a row in `reference/mcp-tools.mdx`). A
**brand-new domain** (`XService` + a new operations group) or a new product surface → usually
structural (a new Guide + Reference page, maybe a new group). The "Update" column below flags which
rows commonly go structural.

## The change → page table (content changes — a convenience over the principle)

| You changed (source) | Update (docs) |
|---|---|
| A **capability**: a service in `packages/core/src/services/` + its `Operation` in `packages/sdk/src/operations/` | `reference/mcp-tools.mdx` (row in the right group) + a workflow in `guides/translate-with-mcp.mdx` (and `guides/code-mode.mdx`) if it enables a new task. REST page auto-generated from the `http` binding. Use the operation name **verbatim**. |
| **Context cascade**: `ContextService`/`ExampleService`/`EscalationService`/`CommentService` (`core/services/`) + the `context`/`examples`/`escalations`/`comments` operation groups (`sdk/src/operations/`); the pure fold algebra in `packages/schema/src/cascade.ts` | `concepts/context-cascade.mdx` (the grid, operators, ladder, brief, examples, lifecycle, context-staleness) + `reference/mcp-tools.mdx` (the Context / Examples / Escalations / Comments groups; glossary's `scope`/`lifecycle`) + `concepts/how-agents-use-turjuman.mdx` (the brief/escalate touchpoints) + `concepts/lifecycle.mdx` (the `escalated` flow, context-change staleness) + `reference/glossary.mdx` vocabulary |
| **Branching / releases / feedback**: `BranchService` (create + merge) / `ReleaseService` / `FieldReportService` (`core/services/`) + the `branches` (`create_branch`/`merge_branch`) / `releases` / `field_reports` operation groups (`sdk/src/operations/`) — all **MCP-only** (no `http` binding) | `concepts/branching-and-releases.mdx` (copy-on-write branches, merge→escalation, immutable releases / "live = latest release", field-report reopen + context fan-out) + `reference/mcp-tools.mdx` (extend Branches; add Releases + Field reports groups) + `guides/webhooks.mdx` (`field-report.opened`/`field-report.resolved`; releases emit none) + `concepts/lifecycle.mdx` (field-report return edge, merge conflict → `escalated`) + `concepts/how-agents-use-turjuman.mdx` (Ship + Stay-correct steps) + `concepts/architecture.mdx` (`Release`/`FieldReport` entities, `#BR#` segment, `REL#` partition) |
| A **brand-new domain** (`XService` + a new operations group) | **Usually structural** — a new Guide (the task) + a new Reference surface, registered in `docs.json`; a Concept page only if there's a non-obvious model. See *Structural changes*. |
| A **CLI command or flag** (`packages/cli/src/`, commands in `src/commands/`) | `reference/cli-commands.mdx` (+ `guides/sync-with-cli.mdx` if the workflow changed; + `self-hosting/deploy.mdx` for deploy/teardown/status) |
| A **file-format adapter** (`packages/formats/src/`, `ADAPTERS` in `formats/src/index.ts`) | `reference/file-formats.mdx` |
| A **QA check** (`packages/schema/src/qa/checks/`, `CHECKS` in `qa/index.ts`) | `reference/qa-checks.mdx` (catalogue row + any limit); `guides/quality-checks.mdx` only if behaviour changed |
| A **data-model / schema field** (`packages/schema/src/domain.ts`; repository in `packages/core/src/repository/`) | `concepts/architecture.mdx`; + `concepts/lifecycle.mdx` if it's lifecycle state (`lifecycle`, `head`, `origin`, `stale`, `sourceRevision`); + a `reference/glossary.mdx` term if it adds vocabulary |
| **RBAC / permissions / roles** (`packages/schema/src/rbac.ts`) | `concepts/roles-and-permissions.mdx`; + a `reference/glossary.mdx` term if a role is added; + `self-hosting/security.mdx` if key scoping changes |
| **MCP surface: the three tools or transport** (`packages/mcp-server/src/codemode.ts`, `protocol.ts`) | `reference/mcp-tools.mdx` + `guides/connect-claude-code.mdx` + `concepts/how-agents-use-turjuman.mdx` + `guides/code-mode.mdx` (the `search`/`describe`/`run_code` how-to) |
| **CDK construct / deploy / config** (`packages/aws-cdk/src/`, deploy primitives in `packages/deploy-internal/src/`; first-owner `bootstrap` route/command) | `self-hosting/deploy.mdx` (flow, outputs, commands); + `self-hosting/configuration.mdx` for stack props/tuning; + `self-hosting/security.mdx` for auth/key/bootstrap changes |
| **Product framing / MCP-first scope** (the non-goals: no web UI, no MT engine) | `concepts/why-mcp-first.mdx` |
| **Tests / tiers** (`packages/*/`, `.github/workflows/`) | `CLAUDE.md` / `TESTING.md` (no docs-site page today) |
| **Shipped/planned status** | `ROADMAP.md` at the repo root — not a docs page; refer to it in prose, don't link it |

## Structural changes (the docs shape itself)

**Governing rule — live nav holds only real, substantial pages.** Never register an empty or
placeholder page in `docs.json` to "reserve a slot," and never split a tab into stubs you intend to
fill later. A page joins the navigation only when it has real content; until then it waits in the
**Backlog map** below. This follows Diátaxis: an empty structure is worse than no structure. When a
backlog page earns its content, promote it (write it, register it, cross-link it) in one change.

### The structure today (where things live, and why)

`docs/` follows a Diátaxis-by-directory convention, surfaced as **three** `docs.json` tabs organized
**by concern** — use the product, look up facts, run your own instance:

```
docs/
├── introduction.mdx          # Using › Get Started — landing/overview (root)
├── quickstart.mdx            # Using › Get Started — deploy-first tutorial (root)
├── concepts/                 # Using › Concepts — explanation: the model + the why
├── guides/                   # Using › Guides — how-to task walkthroughs (incl. try-it-locally, connect-claude-code)
├── reference/                # Reference tab — exhaustive catalogues (tools, CLI, REST API, formats, QA, glossary)
├── self-hosting/             # Self-hosting tab — operator how-tos (overview, deploy, configuration, security)
└── api-reference/            # the auto-generated openapi.json only (powers the Reference tab's Endpoints group)
```

- **Using Turjuman** — everything about *using the product*, deployment-agnostic: Get Started,
  Concepts, Guides. Nothing here should assume self-hosting (see the SaaS note in the Backlog map).
- **Reference** — *look up facts*: the Reference group (tools, CLI, REST API, formats, QA, glossary)
  plus the auto-generated **Endpoints** group (OpenAPI).
- **Self-hosting** — *operate your own instance*: overview, deploy, configuration, security. All
  self-host specifics live here, not in Using/Reference.
- **Root pages** are the two cross-cutting entry points (introduction, quickstart); everything else
  lives under its directory.

### Decision rule — new page vs. group vs. tab

1. **Does an existing page cover it?** Extend that page. Prefer this — don't spawn thin pages, and
   don't register a stub (see the governing rule).
2. **New page, existing area?** Add the `.mdx` under the matching directory and register it in the
   right `docs.json` group (Concepts/Guides under *Using*, the Reference group, or *Self-hosting*).
3. **New area within an existing tab?** Add a new **group** (keep each tab to ≤7 groups; see
   `navigation-and-settings.md`). The "Connect" backlog cluster is the live example: it folds into
   *Guides* until it reaches ≥2 pages, then graduates to its own group.
4. **Genuinely distinct audience or product surface?** A new **tab**. This is rare — justify it. The
   planned **Cloud/SaaS** tab is the one anticipated case; it slots in beside Self-hosting.

Name files in kebab-case matching their nav path (`reference/mcp-tools.mdx` → `"reference/mcp-tools"`).

### The ripple — a structural change is never just one file

Every structural move has consequences beyond the page itself. Do the whole ripple, or you ship broken
nav/links. (The pieces live in other reference files; this is the one place that sequences them.)

- **Add a page** → create it under the right directory · `title` + a tight `description`
  (`pages-and-frontmatter.md`) · **register it in the right `docs.json` group** or it won't appear ·
  cross-link from neighbouring pages (and any `<Card>` hub) · add it to the page list below.
- **Add a group / tab** → apply nav strategy — ≤7 per level, label by user goal, a new tab only for a
  distinct audience (`navigation-and-settings.md`) · update the structure tree above.
- **Move / rename a page** → add a `redirects` entry in `docs.json` (old → new) · fix every inbound
  link (including repo files outside `docs/`, which the CI link check does **not** cover) · rename it
  in the page list · run `mint broken-links`.
- **Split an overgrown page** (a rewrite trigger: mixed topics, or >50% caveats — `writing-craft.md`) →
  create the new pages · redirect/anchor the old URLs · cross-link the set · register all in `docs.json`.
- **Remove a page** → deprecate first if it's user-facing (`deprecated` frontmatter + migration note) ·
  redirect old → replacement · fix inbound links · drop it from `docs.json` **and** the page list below.

After any structural change, `mint broken-links` is the backstop — run it before pushing.

## Backlog map (future pages — record here, do NOT create as stubs)

The home for pages we know we'll want but that don't have real content yet. Keeping them here (not in
`docs.json`) is how we honour the no-stub governing rule. Promote an item to a live page only when you
can write it in full. Group it where shown; create a new group/tab only at the thresholds above.

- **Concepts (Using):** Data model deep-dive · ICU message format & plurals · Security model · Multi-tenancy & orgs
- **Guides (Using):** CI/CD workflows · Manage a glossary · Import/export & bundles · Migrate from another TMS · Agent recipes & examples
- **Connect (folds into Guides until ≥2 pages, then its own group):** Other MCP clients · REST for CI · per-client guides (Cursor, …)
- **Reference:** Configuration reference · Data-model / schema reference
- **Self-hosting:** Upgrades & migrations · Monitoring & alerting · Cost & scaling · Backups & DR · Troubleshooting · Operator topology · Changelog / Releases
- **Footer / GitHub (not docs-site pages):** Development (dev-loop deep-dive) · expanded Contributing · Roadmap

**Deployment-agnostic rule (for the planned SaaS tab).** A hosted/Cloud offering is on the roadmap.
Keep **Using** and **Reference** free of self-host assumptions so a future **Cloud/SaaS** tab can slot
in beside **Self-hosting** without rewriting them. Push deploy/account/billing specifics into the
Self-hosting tab; phrase shared concepts (base URLs, keys, endpoints) neutrally — e.g. "your Turjuman
instance's REST endpoint," noting the self-host way to obtain it rather than assuming it.

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

**Using Turjuman** — `introduction` · `quickstart` · `guides/try-it-locally` · `concepts/why-mcp-first` ·
`concepts/architecture` · `concepts/lifecycle` · `concepts/context-cascade` ·
`concepts/branching-and-releases` · `concepts/roles-and-permissions` ·
`concepts/how-agents-use-turjuman` · `guides/translate-with-mcp` ·
`guides/code-mode` · `guides/sync-with-cli` · `guides/quality-checks` · `guides/webhooks` ·
`guides/connect-claude-code`

**Reference** — `reference/mcp-tools` · `reference/cli-commands` · `reference/rest-api` ·
`reference/file-formats` · `reference/qa-checks` · `reference/glossary` (+ the auto-generated
`Endpoints` group from `api-reference/openapi.json`)

**Self-hosting** — `self-hosting/overview` · `self-hosting/deploy` · `self-hosting/configuration` ·
`self-hosting/security`
