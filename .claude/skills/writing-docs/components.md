# Components — which one, when, and the anti-patterns

**Use components.** Mintlify ships a component library organized by *intent* and its content
templates prescribe components as part of the page skeleton (Steps for procedures, Callouts for
emphasis, Fields for params, Cards for navigation). The old "use components sparingly / mostly plain
Markdown" rule contradicted Mintlify and is gone. The judgment that matters is **which component for
which intent** — and not overusing them.

This file bakes that judgment. For exact props and every option, see Mintlify's component reference:
<https://mintlify.com/docs/components>. (For code blocks, code groups, snippets, and variables, see
`content-mechanics.md`.)

## Which component, by intent

| Intent | Reach for | Notes |
|---|---|---|
| Ordered, do-this-then-that procedure | `<Steps>` / `<Step>` | Use it (not a numbered Markdown list) when steps carry code, screenshots, or substeps. |
| Same task across mutually-exclusive surfaces (OS, role, MCP vs CLI vs REST) | `<Tabs>` | Reader only needs one path. |
| Same operation in multiple languages / alternative implementations | `<CodeGroup>` | Tabbed code; see `content-mechanics.md`. |
| Caveat, prerequisite, danger, success, pro-tip | Callouts: `<Note>` `<Tip>` `<Warning>` `<Info>` `<Check>` `<Danger>` | Pick the semantic that matches the message — the type carries meaning. |
| Navigation hub — point readers to other pages | `<Card>` / `<CardGroup>` (lay out with `<Columns>`) | Landing/overview pages; each card = icon + blurb + link. |
| Optional or lengthy detail most readers skip (FAQ, advanced config, edge cases) | `<Accordion>` / `<AccordionGroup>` | Progressive disclosure; collapsed by default. |
| Nested object/field detail under a parameter | `<Expandable>` inside a field | Drill-down without flattening everything into prose. |
| API/SDK parameters, props, response fields | `<ParamField>` / `<ResponseField>` | Renders name + type + required + default consistently — not a hand-built table. |
| Paired request/response examples | `<RequestExample>` / `<ResponseExample>` | Side-by-side examples. |
| Screenshot / image / diagram | `<Frame>` | Gives a border + caption affordance; always add alt text (`writing-craft.md`). |
| Define a term mid-sentence | `<Tooltip>` | Gloss without breaking the flow. |
| Release / changelog entry | `<Update>` | "What's new" entries. |
| Page-top announcement (deprecation, beta) | `<Banner>` | Site- or page-level. |
| Inline status/version label | `<Badge>` / `<Tag>` | Small chip next to a heading or item. |
| Flow / architecture / sequence diagram | Mermaid code block | Diagram-as-code; renders on the site, degrades to a code fence in `.md`. |
| Content tuned to humans vs. agents | `<Visibility for="humans">` / `<Visibility for="agents">` | Strategic for Turjuman — see `discoverability.md`. |

## The decision shortcuts

- **Procedure → `<Steps>`.** Prose paragraphs for an ordered setup is the most common miss.
- **Variants → `<Tabs>` (prose/surface) or `<CodeGroup>` (code).** One canonical path per tab.
- **"By the way / watch out" → a Callout**, not bold prose or a bare `>` blockquote.
- **"Here are the pages you might want next" → `<CardGroup>`.**
- **"Most readers can skip this" → `<Accordion>`.**
- **"Here are the parameters" → `<ParamField>`/`<ResponseField>`.**

## Anti-patterns

- **Wrong-semantic callouts.** `<Warning>` for a mild aside, or `<Danger>` for a tip. Match the type
  to the severity/meaning.
- **Callout spam.** Five callouts in a row means nothing stands out. Emphasis only works when rare —
  keep most content in plain prose and reserve callouts for the genuine exception.
- **Component where prose or a table is clearer.** A `<CodeGroup>` with a single block (just use a
  code fence). `<Card>`s for a two-item list that reads fine as inline links.
- **Hand-built tables for API params** instead of `<ParamField>`/`<ResponseField>` — you lose the
  consistent type/required/default rendering.
- **`<Steps>` for an unordered set**, or a plain numbered list where steps actually carry code/images.
- **Over-nesting** Accordions inside Tabs inside Columns until the structure hides the content.
- **Decorative-only components** — icons, frames, badges with no informational payload.
- **Forgetting the flattened view.** Every page is exported as Markdown (the `.md` URL and
  `llms.txt`). Favor components that degrade gracefully to text and keep the core narrative in prose,
  so an agent reading the flattened page still gets the full meaning. This is the *one* legitimate
  restraint — it is not a reason to avoid components, it's a reason to choose them well.
