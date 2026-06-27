# Navigation & settings

Navigation is structure, and structure is a UX decision — make it deliberately. The judgment is here;
the exhaustive field schema is at <https://mintlify.com/docs/organize/navigation> and
<https://mintlify.com/docs/organize/settings>.

## Navigation strategy (the judgment)

- **Organize by the reader's journey, not your architecture.** Group pages around goals users have,
  not how the codebase is split.
- **Keep top-level sections to ≤7 items.** Past ~7 choices, readers hit decision fatigue.
- **Prefer depth over breadth — but don't bury key pages.** A few groups with focused children beat
  20 top-level entries; just keep frequently-needed pages within ~2 levels.
- **Label by user goal.** Verbs for task sections ("Translate", "Deploy"); nouns for reference
  ("Reference", "API Reference"). Keep labels under ~4 words; no internal jargon.
- **Decide placement before you write.** Adding a page is also deciding where it belongs — do it up
  front so the structure doesn't rot as the docs grow.
- **Separate by concern (or audience) → tabs.** When sections serve genuinely different needs,
  separate them with tabs rather than blending content on shared pages. (Turjuman organizes **by
  concern** into three tabs: **Using Turjuman** for using the product, **Reference** for looking up
  facts, and **Self-hosting** for running your own instance.)

## `docs.json` navigation schema (the shape)

The `navigation` object must have one root-level container — `tabs`, `groups`, or a `dropdown` — and
each level holds one kind of child. Turjuman uses `tabs → groups → pages`. The building blocks:

- **Pages** — leaf entries: file paths relative to `docs/`, without `.mdx` (e.g. `"reference/mcp-tools"`).
  **A page must appear here to show up on the site** (or be reachable-but-unlisted via `hidden: true`
  frontmatter).
- **Groups** — labeled sidebar sections (`group` + `pages`); optional `icon`, `tag`, `expanded`,
  `root`. Groups can nest.
- **Tabs** — top-bar sections, each with its own sidebar and URL path; hold groups/pages/menus.
- **Anchors / Dropdowns** — persistent top-of-sidebar entries for external links or switching between
  large sections.
- **Versions / Languages** — partition the whole navigation by version or locale (see
  internationalization in `writing-craft.md`). Turjuman uses neither today.
- **`openapi`** — a group can point its `openapi` field at an OpenAPI file to auto-generate endpoint
  pages (Turjuman's "Endpoints" group does this; see the OpenAPI section in `SKILL.md`).

Turjuman's current shape, for reference:

```jsonc
"navigation": {
  "tabs": [
    { "tab": "Using Turjuman", "groups": [
      { "group": "Get Started", "pages": ["introduction", "quickstart", "guides/try-it-locally"] },
      { "group": "Concepts",    "pages": ["concepts/why-mcp-first", "concepts/architecture", "concepts/lifecycle", "concepts/roles-and-permissions", "concepts/how-agents-use-turjuman"] },
      { "group": "Guides",      "pages": ["guides/translate-with-mcp", "guides/code-mode", "guides/sync-with-cli", "guides/quality-checks", "guides/webhooks", "guides/connect-claude-code"] }
    ]},
    { "tab": "Reference", "groups": [
      { "group": "Reference",   "pages": ["reference/mcp-tools", "reference/cli-commands", "reference/rest-api", "reference/file-formats", "reference/qa-checks", "reference/glossary"] },
      { "group": "Endpoints",   "openapi": "api-reference/openapi.json" }
    ]},
    { "tab": "Self-hosting", "groups": [
      { "group": "Self-hosting", "pages": ["self-hosting/overview", "self-hosting/deploy", "self-hosting/configuration", "self-hosting/security"] }
    ]}
  ]
},
// Add a redirect whenever a page moves or is renamed, so shared/bookmarked URLs don't 404:
"redirects": [
  { "source": "/self-hosting",          "destination": "/self-hosting/overview" },
  { "source": "/api-reference/overview", "destination": "/reference/rest-api" }
]
```

Adding a page = add its path to the right group. A genuinely new top-level area = a new group (or a
new tab if it's a distinct audience). Prefer extending an existing page over a thin new one.

## Settings (`docs.json` top level)

The required keys are `name`, `theme`, `colors.primary`, and `navigation`; keep the `$schema`
reference for editor validation. Everything else (logo, favicon, navbar, footer, redirects, analytics)
is optional — drill into the settings reference when you need a specific field. The structural ones you
touch most:

- **`redirects`** — add `{ "source": "/old", "destination": "/new" }` whenever you move or rename a
  page, so bookmarked/shared URLs don't 404 (see `discoverability.md`).
- **`navbar` / `footer`** — global links (Turjuman points both at the GitHub repo).
- **`name` / `description` / `colors` / `logo` / `favicon`** — branding; the top-level `description`
  also feeds the `llms.txt` site description, so keep it an accurate one-liner for the whole product.

Don't change theme/colors/branding as part of a content PR unless that's the point of the change.
