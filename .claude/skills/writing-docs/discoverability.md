# Discoverability — SEO, GEO, search, linking, and AI-native docs

How a page gets *found* and *consumed* — by search engines, AI answer engines, in-site search, and
the agents that read Turjuman's docs directly. For an agent-first product this is core, not polish.

## The `description` field (the highest-leverage line on the page)

The `description` frontmatter does triple duty: the **SEO meta description** (the snippet under your
title in search results), the entry in **`llms.txt`**, and the agent-facing one-liner. Write it for all
three:

- **Length:** aim for ~130–160 characters (the search-snippet sweet spot). Never exceed ~300 chars,
  and **never put a line break in it** — Mintlify truncates the `llms.txt` entry at the first newline
  or 300 chars.
- **Voice:** active, lead with what the reader *accomplishes*. "Learn how to configure webhooks to…"
  beats "This page explains webhooks."
- **Self-contained:** an agent may see only this line. Make it stand alone.

> The old rule "description must be one full sentence" was a stricter house rule than Mintlify states —
> the real constraints are length + voice above. One tight sentence is a fine way to hit them.

## SEO (on-page)

- **Titles:** 50–60 characters, unique per page, primary keyword near the front, phrased the way users
  search ("How to…", "…reference"). Don't mirror an internal UI label.
- **Descriptions:** as above (130–160 chars).
- **Headings:** H1 auto-generated from `title` (never add a manual one); H2 for sections, H3 for
  subsections; write them as questions or intent phrases; don't skip levels.
- **Mintlify handles the technical SEO automatically** — sitemap, canonical URLs, semantic heading
  HTML, mobile. You don't configure those; you just write good titles, descriptions, and headings.

## GEO — generative engine optimization (for AI answer engines)

Structuring content so AI systems can understand, trust, and cite it accurately:

- **Lead with the answer.** AI surfaces content that answers the question immediately — put the
  critical info first, caveats after.
- **Query-matching headings.** Phrase H2/H3 as the question a user would ask, not a topic label.
- **Be specific.** Concrete values ("rate limit of 100 requests per minute"), exact boundary behavior,
  and runnable code beat vague claims.
- **Consistent terminology.** One name per concept throughout (also a voice rule) — prevents AI
  confusion when chunks are excerpted.
- **Specific nouns over pronouns.** A chunk may be lifted out of context; "the API key" survives where
  "it" doesn't.
- **Clean structure.** Sequential headings, language-tagged code blocks, lists, alt text — all make a
  page parseable. `llms.txt` is auto-generated (no config); just write parseable pages.

## In-site search

Mintlify ranks content *chunks* by relevance. Author for findability with clear headings and
chunkable structure. Tuning knobs (use sparingly): per-page `boost` (frontmatter, >1 up / <1 down,
inherited down the nav tree) and `keywords` (synonyms that don't appear in the body). Large boosts let
weak pages dominate — reach for them rarely.

## Linking

- **Root-relative paths** (start with `/`): `/concepts/lifecycle`. Mintlify's recommended style — they
  survive directory moves and domain changes. Relative `./`/`../` paths work but break more often;
  avoid them.
- **Descriptive link text** that names the destination — never "click here" / "read more" (hurts both
  accessibility and SEO).
- **Anchors** are auto-generated from headings (lowercased, spaces → hyphens). Link a section with
  `/path/to/page#section`; override an anchor id with `{#custom-id}`.
- **Redirects on move/rename:** add `{ "source", "destination" }` to `docs.json` `redirects` so
  bookmarked URLs don't 404.
- **Don't link repo-internal files** (e.g. `ROADMAP.md`, source files) from docs pages — they aren't
  part of the published site and the link checker will flag them. Refer to them in plain prose instead.
- **Verify with `mint broken-links`** before pushing.

## AI-native docs (Turjuman is agent-first)

Mintlify auto-generates and serves these — you don't hand-maintain them, but your authoring decides
how good they are:

- **`llms.txt`** — an index: site title + description + per-page links and `description`s. **`llms-full.txt`**
  — the entire docs concatenated into one file. Because every Turjuman capability is declared once as a
  `@turjuman/sdk` operation and surfaced in the reference docs, `llms-full.txt` becomes a near-complete
  agent manual for free — which is a strong reason to keep the reference pages complete and accurate.
- **Markdown export:** any page is fetchable as clean Markdown by appending `.md` to its URL (or via
  `Accept: text/markdown`). `Cmd/Ctrl + C` copies a page as Markdown; the per-page menu offers "open in
  Claude/ChatGPT". So **every page must read well as flattened Markdown** — favor components that
  degrade gracefully (`components.md`).
- **`<Visibility>`:** `<Visibility for="agents">` / `for="humans">` lets you embed agent-only
  operational guidance (exact operation names, `run_code` snippets) that doesn't clutter the human site
  — without forking a separate agent doc (which the repo forbids). One source, two tuned audiences.
- **robots.txt:** keep AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) unblocked so
  the docs can be cited.

**Validate GEO/AI-friendliness** by asking an AI tool real Turjuman questions and checking it cites the
docs accurately and the code examples actually run.
