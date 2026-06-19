---
name: writing-docs
description: >-
  Write and maintain Turjuman's Mintlify documentation (the docs/ MDX pages + docs.json). Use when
  adding or updating docs for a new or changed MCP tool, REST route, CLI command/flag, file-format
  adapter, QA check, service/capability, or data-model field — or when creating any new docs page or
  reorganizing navigation. Encodes the Mintlify conventions, the docs.json structure, and the
  Diátaxis page-type mapping so docs stay consistent and serve humans and agents from one source.
---

# Writing Turjuman documentation

Turjuman keeps **one** documentation set in `docs/`, published with [Mintlify](https://mintlify.com).
That single source serves three audiences:

- **Human readers** — the rendered site.
- **External agents** — Mintlify auto-generates `llms.txt` / `llms-full.txt`, a per-page "open in
  Claude/ChatGPT / copy as Markdown" menu, and a docs MCP. The page `description` frontmatter is what
  feeds `llms.txt`, so it must be a real one-sentence summary.
- **The agents working in this repo** — they read these MDX files directly.

There is no separate "agent doc." Write each page so it reads cleanly as plain Markdown in-repo
**and** renders well on the site. **Docs change in the same PR as the code that changed.**

## The golden rules

1. **Frontmatter on every page**: `title` (short) and `description` (one full sentence — it's the
   `llms.txt` summary and the SEO/social description). Nothing else is required.
2. **Register the page** in the `navigation` of `docs/docs.json`, or it won't appear on the site.
   Page paths are relative to `docs/` and omit the `.mdx` extension (e.g. `reference/mcp-tools`).
3. **Pick the right page type** (Diátaxis — see `doc-types.md`): a *Concept* explains, a *Guide*
   walks through a task, a *Reference* lists exhaustively. Don't blur them — put the narrative in the
   guide and the exhaustive table in the reference, and cross-link.
4. **Mostly plain Markdown.** Use Mintlify components sparingly and only where they add value:
   `<Note>`/`<Tip>`/`<Warning>` for callouts (replacing bare `> ` blockquote warnings), `<Steps>` for
   ordered procedures, `<Tabs>` for per-surface variants (MCP/CLI/REST), `<CardGroup>`/`<Card>` for
   landing-page links, `<Accordion>` for optional detail. Avoid anything that turns into noise when
   read as raw text.
5. **Link with site-root paths** (`/concepts/lifecycle`), not file paths, between published pages.
   Link to repo-only files (e.g. `ROADMAP.md`) with absolute GitHub URLs so the
   link-checker doesn't flag them and they resolve off-site.
6. **Match the house voice**: direct, second person, present tense, concrete. Lead with what the
   reader does, not background. Keep the MCP-first / developer-first framing; never imply a web UI or
   built-in MT engine (deliberate non-goals).

## Where each project element gets documented

When code changes, update the matching page(s). See `element-map.md` for the full table; the common
cases:

| You changed… | Update | Page type |
|---|---|---|
| An **MCP tool** (`mcp-server/src/tools/`) | `reference/mcp-tools.mdx` (the catalogue) + a workflow in `guides/translate-with-mcp.mdx` if it enables a new task | Reference (+ Guide) |
| A **REST route** (`api/src/router.ts`) | the relevant `reference/*` page (surfaces table) | Reference |
| A **CLI command or flag** (`cli/src/`) | `reference/cli-commands.mdx` (the table) + `guides/sync-with-cli.mdx` if it changes the workflow | Reference (+ Guide) |
| A **file-format adapter** (`packages/formats/src/`) | `reference/file-formats.mdx` | Reference |
| A **QA check** (`packages/schema/src/qa/checks/`) | `reference/qa-checks.mdx` (catalogue row + any limit) | Reference |
| A **new domain/capability** (`core/services/`) | a new Guide and/or Concept page, plus its Reference surface; add to `docs.json` | depends |
| A **data-model / schema field** (`packages/schema/src/domain.ts`, repository) | `concepts/architecture.mdx` (and `concepts/lifecycle.mdx` if it's lifecycle state) | Concept |
| **Auth / RBAC** (`packages/schema/src/rbac.ts`) | `concepts/roles-and-permissions.mdx` | Concept |
| **Deploy / infra** (`packages/aws-cdk/`, `packages/aws-deploy/`, `turjuman-aws-deploy`) | `self-hosting.mdx` | Guide |

A brand-new top-level area is a new group/tab in `docs.json`. Prefer extending an existing page over
spawning a thin new one.

## API reference (OpenAPI — auto-generated)

Don't hand-write REST endpoint pages. The API serves its own OpenAPI 3.1 spec at `GET /v1/openapi.json`
(hono-openapi + the shared zod schemas). `npm run gen:openapi` snapshots it to
`docs/api-reference/openapi.json`, and the "API reference" group in `docs/docs.json` points its
`openapi` field at that file, so Mintlify generates a page + interactive playground per endpoint.

- New/changed route → annotate it with `describeRoute({ summary, tags, parameters, responses })` in
  `packages/api/src/router.ts`. `tags` become the sidebar grouping.
- The `.githooks/pre-commit` hook (installed by `npm install`) rebuilds + regenerates + stages the
  snapshot automatically when API/core source is staged; `npm run gen:openapi` does it manually. CI
  fails on drift.
- The spec lists the API *contract*; the playground's server URL is a placeholder because each install
  has its own `ApiUrl`.

## Authoring workflow

1. Identify the page type and target file from the table above (and `doc-types.md`).
2. Start from the matching template in `templates/` (concept / guide / reference / landing).
3. Write the page. Reuse exact tool names, flags, and field names from the code — grep the source to
   be sure (`mcp-server/src/tools/`, `api/src/router.ts`, `core/domain.ts`).
4. Add/confirm the page in `docs/docs.json` `navigation`.
5. Validate (below). Then commit docs **with** the code change.

## Validate before committing

```bash
# live preview at http://localhost:3000 (run from the docs/ folder)
cd docs && npx mint dev

# check internal links resolve (also runs in CI)
cd docs && npx mint broken-links
```

If `mint` isn't installed: `npm i -g mint`. CI runs the broken-links check on every PR, so fix
reported links before pushing.

## Checklist

- [ ] `title` + a real one-sentence `description` in frontmatter.
- [ ] Correct page type; narrative vs. exhaustive content not blurred.
- [ ] Registered in `docs/docs.json` navigation (path is `.mdx`-less, relative to `docs/`).
- [ ] Cross-links use `/site-root` paths; repo-only files use absolute GitHub URLs.
- [ ] Tool/flag/field names match the code verbatim.
- [ ] Components used only where they help; reads fine as raw Markdown.
- [ ] `mint broken-links` passes.
- [ ] Updated in the same change as the code it documents.
