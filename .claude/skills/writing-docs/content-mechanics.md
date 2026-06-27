# Content mechanics — code blocks, code groups, snippets, variables

The building blocks you reach for on almost every page. Exact reference:
<https://mintlify.com/docs/create/code>, <https://mintlify.com/docs/components/code-groups>,
<https://mintlify.com/docs/create/reusable-snippets>.

## Code blocks

**Always specify the language first** — it must come before any other meta option, and it drives
syntax highlighting (Shiki), accessibility, and AI parsing. After the language, options combine in
any order.

| Capability | Syntax | Use it for |
|---|---|---|
| Language (required) | ` ```ts ` | Every fenced block. Never leave it bare. |
| Title (inline) | ` ```ts Example title ` | A label or file path above the block. |
| Title (property) | ` ```ts title="utils/hello.ts" ` | When the title needs special chars/quoting. |
| Icon | ` ```ts icon="square-js" ` | A Lucide/Font Awesome icon on the block. |
| Line highlight | ` ```ts highlight={1-2,5} ` | Call attention to specific lines. |
| Line focus | ` ```ts focus={2,4-5} ` | Dim everything except the focused lines. |
| Line numbers | ` ```ts lines ` | Long blocks where line refs matter. |
| Expandable | ` ```ts expandable ` | Long blocks that should collapse by default. |
| Wrap | ` ```ts wrap ` | Avoid horizontal scroll on long lines. |
| Diff | `// [!code ++]` / `// [!code --]` | Show added/removed lines (use the language's comment token; `:n` suffix spans n lines). |
| Twoslash | ` ```ts twoslash ` | TS/JS only — hover for inferred types/errors. |

Code blocks are copyable by default. For Turjuman, prefer real, runnable snippets that match the
actual tool/operation names and flags (an agent may copy them verbatim).

## Code groups

Wrap two or more fenced blocks in `<CodeGroup>` to get a tabbed interface — **each block's title
becomes its tab label.** Use it to compare implementations across languages or show alternative
approaches (e.g. the same install via npm/pnpm, or an MCP call vs the CLI equivalent).

```mdx
<CodeGroup>
  ```bash npm
  npm install @turjuman/cli
  ```
  ```bash pnpm
  pnpm add @turjuman/cli
  ```
</CodeGroup>
```

Selecting a language syncs all matching groups on the page. `<CodeGroup dropdown>` swaps the tabs for
a dropdown. A single-block "group" is an anti-pattern — just use a code fence.

## Reusable snippets (DRY)

When the same content appears on multiple pages, define it once as a snippet and import it, so you
edit one file instead of many.

- **Location:** any file under `/snippets/` is treated as a snippet. Snippet files can be `.mdx`,
  `.md`, or `.jsx`.
- **Import paths:** absolute from project root (`/snippets/foo.mdx`) or relative (`./`, `../` — the
  relative form gets you CMD-click navigation in the editor).
- **Text snippet:**

  ```mdx
  import Prereqs from "/snippets/prereqs.mdx";

  <Prereqs />
  ```

- **JSX snippets must use arrow functions** (`export const X = () => ...`); the `function` keyword is
  not supported. Snippets don't work in the web editor — edit MDX locally or push directly to the repo.

## Variables

Export values from a snippet file and import them where needed — useful for a version, a base URL, or
a package name reused across pages (and **inside** code fences):

```mdx
export const cliVersion = "0.2.0";
```

```mdx
import { cliVersion } from "/snippets/vars.mdx";

The current CLI is {cliVersion}.
```

You can also parameterize a snippet by passing props at the use site (`<MySnippet word="bananas" />`)
and interpolating `{word}` inside it. Keep variables for genuinely shared, drift-prone values — don't
over-abstract one-off strings.
