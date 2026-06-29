# Writing craft — voice, audience, accessibility, media, maintenance

The craft of the words and assets. Distilled from Mintlify's style-and-tone, understand-your-audience,
accessibility, media, and maintenance guides.

## Voice & tone

- **Second person, active voice, present tense.** "The API returns an error when the token expires,"
  not "An error is returned…". Write like a knowledgeable colleague, not a corporate brochure.
- **Lead with what the reader does**, not background. Put the answer first, then the context.
- **One idea per sentence; keep sentences under ~25 words.** If a sentence needs several commas, split
  it. 2–4 sentences per paragraph. Use lists/`<Steps>` for sequences, not run-on prose.
- **One term per concept.** Don't alternate "API key" / "token" / "credential". Match the words your
  users use ("webhook" if they say webhook). Define a new term in context rather than linking away.
- **Cut filler:** "it's worth noting that", "in order to", "simply", "please". Don't editorialize
  ("this powerful feature") — show, don't sell.
- **Headings are intent phrases**, not topic labels: "Connect your MCP client", not "MCP client
  configuration". Sentence case. Don't skip levels (H2 → H3). Never write a manual H1 — the `title`
  frontmatter generates it.
- **Calibrate tone to the page's audience:** warmer and more guided for getting-started; dense and
  precise for reference.

## Know your audience

- **One primary reader per page.** Writing for "everyone" serves no one. Name the reader (new user,
  app developer, admin, operator) and calibrate depth to *their* knowledge, not your team's.
- **Document with the user's terminology first**, then introduce product terms. Define technical terms
  on first use; link deeper explanations rather than interrupting every page with basics.
- **Don't blend distinct personas on one page.** If two audiences need genuinely different content,
  split into separate pages or tabs (see `navigation-and-settings.md`).
- For Turjuman specifically, the **agent** is a first-class reader — see `discoverability.md` for the
  AI-native implications (descriptions, `.md` exports, `<Visibility>`).

## Accessibility (also helps SEO and AI parsing)

- **Headings:** one H1 (from `title`), sequential levels, unique names at each level.
- **Alt text on every image:** describe what it shows and why it matters; don't start with "Image of"
  (screen readers already say that). One or two sentences.
- **Link text is meaningful** and names the destination — never "click here" / "read more".
- **Don't rely on color alone** — pair it with text or an icon. Body text contrast ≥ 4.5:1.
- **Tables only for real tabular data**, always with headers.
- **Every code block declares its language**; break long examples into chunks; use descriptive
  variable names; don't use ASCII art for structure (use a Mermaid diagram or a list).

## Media & images

- **Formats:** PNG for screenshots/diagrams, WebP for photos, GIF only when animation is essential.
- **Wrap images in `<Frame>`** for a border + caption affordance; always include alt text.
- **Size:** keep native resolution or scale *down* (never enlarge); ~800–1200px wide; crop tightly to
  the relevant UI.
- **Name files descriptively in kebab-case** (`api-keys-settings.png`), not `screenshot-2024.png`.
- **Host video externally** (don't commit large files); GIFs only for short loops.
- **Avoid screenshots of fast-changing UI** where prose suffices — they're the first thing to rot.

## Internationalization (brief)

Turjuman's docs are English-only today. If that ever changes, Mintlify uses one directory per language
(ISO 639-1 codes) mirroring the default structure, configured via `navigation.languages` — never reuse
a page path across languages, translate only code *comments*, and keep content parity. Reference:
<https://mintlify.com/docs/guides/internationalization>.

## Maintenance

- **Update docs in the same PR as the code** — this is the single biggest defense against drift, and
  it's a repo rule (`CLAUDE.md`).
- **Run `mint broken-links`** before pushing; CI runs it too.
- **Rewrite triggers:** repeated edits haven't fixed user confusion; a page mixes disparate topics;
  the structure no longer matches the product; more than half the page is caveats.
- **Deprecate, then remove:** mark a superseded page `deprecated` with a clear migration path; when you
  actually remove it, add a redirect and fix inbound links rather than leaving stale content up.
- **Improve where it matters:** prioritize high-traffic, low-satisfaction pages; respond immediately
  to specific feedback ("this example doesn't work"); audit periodically for stale examples.
