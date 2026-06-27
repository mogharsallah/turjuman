---
name: writing-docs
description: >-
  Craft and maintain Turjuman's Mintlify documentation (the docs/ MDX pages + docs.json) to a high
  standard. Use when adding or updating docs for a new or changed MCP tool / SDK operation, REST
  route, CLI command/flag, file-format adapter, QA check, service/capability, or data-model field —
  or when creating any page, choosing a page type, picking components, writing frontmatter, or
  reorganizing navigation. Encodes Mintlify's own best practices (content types, components, writing
  craft, navigation, SEO/GEO, AI-native docs) plus the Turjuman code→docs map, so docs stay
  excellent and serve humans, search engines, AI answer engines, and agents from one source.
---

# Writing great Turjuman documentation

This skill is two things at once: a **craft guide for building excellent Mintlify docs**, wired to
**Turjuman's specific repo**. The craft rules are distilled from Mintlify's own best-practices pages
(cited in the reference files); the wiring tells you exactly which page to touch when code changes.

Turjuman keeps **one** documentation set in `docs/`, published with [Mintlify](https://mintlify.com).
That single source serves four audiences, and good docs serve all four at once:

- **Human readers** — the rendered site.
- **Search engines** — page `title`/`description` become meta tags; Mintlify handles sitemaps,
  canonical URLs, and heading semantics automatically.
- **AI answer engines** — Mintlify auto-generates `llms.txt` / `llms-full.txt` and a per-page
  "copy as Markdown / open in Claude/ChatGPT" menu. Each page is also fetchable as clean Markdown by
  appending `.md` to its URL.
- **The agents working in this repo** — they read these MDX files (and the `.md` exports) directly.

For an MCP-first, agent-first product, the agent audience is **first-class**, not an afterthought —
but there is still no separate "agent doc." Write each page once so it renders well on the site
**and** flattens cleanly to Markdown. **Docs change in the same PR as the code that changed.**

## The golden rules

1. **Frontmatter on every page.** `title` (short, sentence case) and `description` (a tight,
   front-loaded summary in active voice that says what the reader accomplishes). The description is
   the page's search-result snippet, social card, **and** its `llms.txt`/agent-facing line — aim for
   ~130–160 characters; never exceed ~300 and never put a line break in it (Mintlify truncates the
   `llms.txt` entry at the first newline or 300 chars). See `pages-and-frontmatter.md` and
   `discoverability.md`.

2. **Pick the page's primary job.** Diátaxis is the mental model — *explanation* (a Concept),
   *how-to* (a Guide), *reference*, or *tutorial*. Lead with one job per page; don't bury an
   exhaustive option table inside a narrative guide, and don't put a workflow narrative inside a
   reference. Mintlify (and we) **allow blending** when a page genuinely serves two needs — a
   quickstart legitimately mixes tutorial + how-to. Cross-link instead of duplicating whole tables.
   See `doc-types.md`.

3. **Reach for the right component for each intent — don't avoid components.** `<Steps>` for ordered
   procedures, `<Tabs>`/`<CodeGroup>` for per-surface or per-language variants, `<Note>`/`<Tip>`/
   `<Warning>` for caveats, `<Card>`/`<CardGroup>` for navigation hubs, `<Accordion>`/`<Expandable>`
   for optional or nested detail, `<ParamField>`/`<ResponseField>` for parameters, `<Frame>` for
   images. The only restraint: choose components that still flatten cleanly to Markdown (the `.md` /
   `llms.txt` view), and use `<Visibility>` to split human-only vs agent-only content rather than
   forking a page. See `components.md` and `content-mechanics.md`. *(This reverses the old skill's
   "mostly plain Markdown / use components sparingly" rule, which contradicted Mintlify.)*

4. **Register and place the page deliberately.** Add it to `docs/docs.json` `navigation` or it won't
   appear (paths are relative to `docs/`, no `.mdx`). Decide *where it belongs* before you write.
   Keep top-level groups to ≤7 items, prefer depth over breadth (but don't bury key pages past two
   levels), and label by user goal (verbs for tasks, nouns for reference). See
   `navigation-and-settings.md`.

5. **Link with root-relative paths.** `/concepts/lifecycle`, not a file path — Mintlify's
   recommended style, because it survives directory moves and domain changes. Use descriptive link
   text (never "click here"); add a redirect in `docs.json` when you move/rename a page. Repo-only
   files (e.g. `ROADMAP.md`) are *not* docs pages — refer to them in plain prose, don't link them.
   See `discoverability.md`.

6. **Write for the reader and the answer engine.** Direct, second person, present tense, active
   voice. Lead with the answer, then the context. One term per concept (never alternate "API key" /
   "token"). Prefer concrete values ("100 requests per minute") over vague claims, and specific
   nouns over pronouns (a chunk may be excerpted out of context). Keep sentences under ~25 words.
   See `writing-craft.md` and `discoverability.md`.

7. **Keep Turjuman's framing and architecture.** MCP-first / developer-first; never imply a web UI
   or a built-in machine-translation engine (deliberate non-goals). Capabilities are declared once
   as **operations** in `@turjuman/sdk` and projected to both the MCP and REST surfaces — so a new
   capability is documented at the operation/reference level, not per transport. See `element-map.md`.

## Reference files (read the one you need)

| File | What it covers |
|---|---|
| `doc-types.md` | Page types: Diátaxis as the model, reconciled with Mintlify's looser "content types"; which template to start from. |
| `writing-craft.md` | Voice & tone, audience, accessibility, media/images, and maintenance — the craft of the words and assets. |
| `components.md` | The component catalog, which-component-when, and the anti-patterns. |
| `content-mechanics.md` | Code blocks (highlight/focus/lines/diff/expandable), code groups, reusable snippets, and variables. |
| `pages-and-frontmatter.md` | Every frontmatter field and the page `mode` layouts. |
| `navigation-and-settings.md` | Navigation strategy and the `docs.json` navigation/settings schema. |
| `discoverability.md` | SEO, GEO (AI answer engines), in-site search, linking, and AI-native docs (`llms.txt`, `.md` export, `<Visibility>`). |
| `element-map.md` | **Turjuman-specific:** which doc page each kind of code change must update. |
| `templates/` | Starting skeletons: `concept.mdx`, `guide.mdx`, `reference.mdx`, `tutorial.mdx`, `landing.mdx`. |

## Where each Turjuman change gets documented

When code changes, update the matching page(s) in the **same PR**. The durable principle:

> A capability is one **service** (`core/services/`) + one **operation** (`packages/sdk/src/operations/`),
> documented **once at the reference level** (`reference/mcp-tools.mdx`) plus a workflow guide if it
> enables a new task. The REST endpoint page is auto-generated from the operation's `http` binding —
> never hand-written. Domain concepts (schema fields, RBAC) go to `concepts/`; CLI to
> `reference/cli-commands.mdx`; formats and QA checks to their `reference/` page.

**First decide whether the change is a *content* edit or a *structural* one** — a new page, group, or
tab, or splitting/moving/renaming a page (a new *domain* usually is structural; another operation in an
existing group usually isn't). They're different jobs: a structural change has a ripple (register in
`docs.json`, redirect moved URLs, fix inbound links). **`element-map.md` is the single authoritative
source** for both — the change→page table, the `docs/` structure + new-page/group/tab decision rule,
and the structural-change ripple checklist. Open it; don't re-derive the mapping here.

## API reference (OpenAPI — auto-generated, never hand-written)

Don't hand-write REST endpoint pages. The API serves its own OpenAPI 3.1 spec at
`GET /v1/openapi.json` (hono-openapi + the shared zod schemas). `pnpm run gen:openapi` snapshots it
to `docs/api-reference/openapi.json`, and the "Endpoints" group in `docs/docs.json` points its
`openapi` field at that file, so Mintlify generates a page + interactive playground per endpoint.

- A route that maps cleanly to an operation is generated via `projectOperation(...)` and carries the
  operation's `describeRoute({ summary, tags, ... })` annotation automatically; bespoke routes need
  the annotation written by hand. `tags` become the sidebar grouping.
- The `.githooks/pre-commit` hook (installed by `pnpm install`) rebuilds + regenerates + stages the
  snapshot automatically when API/core source is staged; `pnpm run gen:openapi` does it manually. CI
  fails on drift. `docs/api-reference/openapi.json` is Biome-excluded — never reformat it by hand.

## Authoring workflow

1. **Content or structural?** Decide whether you're editing an existing page or changing the docs shape
   (new page/group/tab, or split/move/rename). If structural, follow the decision rule **and the ripple
   checklist** in `element-map.md` (register in `docs.json`, redirect moved URLs, fix inbound links).
2. Decide the page's **placement in `docs.json`** and its **primary job** (`doc-types.md`).
3. Start from the matching template in `templates/`.
4. Write it. Reuse exact tool/operation names, flags, and field names from the code — grep the source
   to be sure (`packages/sdk/src/operations/`, `packages/cli/src/`, `packages/schema/src/domain.ts`).
5. Choose components by intent (`components.md`); write a tight `description` (`discoverability.md`).
6. Add/confirm the page in `docs/docs.json` `navigation`.
7. Validate, then commit docs **with** the code change.

## Validate before committing

```bash
# live preview at http://localhost:3000 (run from the docs/ folder)
cd docs && npx mint dev

# check internal + external links resolve (also runs in CI)
cd docs && npx mint broken-links
```

If `mint` isn't installed: `npm i -g mint`. CI runs the broken-links check on every PR — fix
reported links before pushing. Treat any Mintlify preview/build check on the PR as **non-blocking**.

## Checklist

- [ ] `title` (sentence case) + a tight, front-loaded `description` (~130–160 chars, ≤300, no line break).
- [ ] Right primary job for the page; narrative vs. exhaustive content not blurred.
- [ ] Components chosen by intent (Steps/Tabs/Callouts/Cards/Fields/Frame), not avoided — and still readable as flattened Markdown.
- [ ] Registered in `docs/docs.json` navigation (path is `.mdx`-less, relative to `docs/`); placed sensibly.
- [ ] Root-relative `/links` with descriptive text; redirect added if a page moved.
- [ ] Tool/operation/flag/field names match the code verbatim.
- [ ] Leads with the answer; one term per concept; concrete values; specific nouns over pronouns.
- [ ] `mint broken-links` passes.
- [ ] Updated in the same change as the code it documents.
