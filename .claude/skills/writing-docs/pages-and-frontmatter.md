# Pages & frontmatter

Every page is an `.mdx` file under `docs/` with YAML frontmatter at the top. Reference:
<https://mintlify.com/docs/organize/pages>.

## Frontmatter fields

`title` and `description` are what you set on essentially every page; the rest are situational.

| Field | Type | What it does | When to set |
|---|---|---|---|
| `title` | string | Page title in nav + browser tab; generates the page's H1. Sentence case. | Always. (Falls back to the filename if omitted — don't rely on that.) |
| `description` | string | One-line summary shown under the title; becomes the SEO meta description **and** the `llms.txt` entry. | Always — see `discoverability.md` for the length/voice rules. |
| `sidebarTitle` | string | Shorter label for the sidebar when the full title is long. | When `title` is too long for the sidebar. |
| `icon` | string | Icon next to the page (Lucide / Font Awesome name, URL, or local path). | To strengthen visual nav hierarchy. |
| `iconType` | string | Font Awesome style (`solid`, `regular`, `brands`, …). | Only with a Font Awesome icon. |
| `tag` | string | Small badge next to the title (e.g. `NEW`, `Beta`). | To flag status. |
| `mode` | string | Page layout — see the table below. | Landing, wide, or focused pages. |
| `url` | string | Makes the nav entry link to an external site instead of a page. | External resource entries. |
| `noindex` | boolean | Excludes the page from search, sitemap, indexing, and AI assistant context; stays in nav. | Supplementary pages not meant to be found. |
| `hidden` | boolean | Removes the page from the sidebar but keeps the URL reachable (also prevents indexing). | Drafts / unlinked-but-accessible pages. |
| `deprecated` | boolean | Shows a "deprecated" label; page stays accessible. | Legacy pages pending removal. |
| `keywords` | string[] | Extra terms for in-site search that don't appear in the body. | Boost discoverability for synonyms. |
| `boost` | number | Multiplies in-site search ranking (>1 up, <1 down). | Tune prominence sparingly. |
| `og:*` / `twitter:*` | string | Custom social/meta tags (quote keys with colons). | Custom social cards. |
| `api` / `openapi` | string | Renders an interactive API playground. | API endpoint pages — but Turjuman generates these from the OpenAPI snapshot; don't hand-author. |

A short, well-formed `title` + `description` is the highest-leverage thing on the page: it drives the
sidebar, search results, social cards, and the agent-facing `llms.txt` line.

## Page layout modes (`mode`)

Set `mode` in frontmatter to change the surrounding UI. Reference:
<https://mintlify.com/docs/guides/custom-layouts>.

| `mode` | Keeps | Removes | Use for |
|---|---|---|---|
| `default` (omit the field) | sidebar, TOC, footer | — | Standard pages — the default. |
| `wide` | sidebar, footer | TOC | Pages with few headings or that need extra width. |
| `center` | footer | sidebar, TOC | Changelogs, focused reading. (Theme-dependent.) |
| `custom` | — | sidebar, TOC, footer | Full-canvas landing/marketing pages — most control. |
| `frame` | sidebar | TOC | Custom content that still needs the sidebar. (Theme-dependent.) |

For custom layouts: test light **and** dark mode, constrain width with `max-w-*` classes, use
Tailwind/CSS rather than inline `style`, and remember Tailwind arbitrary values aren't supported.
Turjuman's default pages use `default`; reserve `custom`/`center` for landing or changelog-style pages.
