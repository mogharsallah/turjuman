# Page types (Diátaxis) for Turjuman

Mintlify recommends the [Diátaxis](https://diataxis.fr) framework. Every page is exactly one of four
types. Picking the right one — and not mixing them — is what keeps the docs scannable.

| Type | Answers | Reader is… | Turjuman examples | Lives under |
|---|---|---|---|---|
| **Concept** (explanation) | "Why / how does it work?" | understanding | architecture, lifecycle, roles & permissions | `docs/concepts/` |
| **Guide** (how-to) | "How do I do X?" | working on a task | translate with MCP, sync with the CLI, run QA, receive webhooks, self-host | `docs/guides/` (+ `quickstart`, `self-hosting` at root) |
| **Reference** | "What exactly is the API/flag/field?" | looking something up | MCP tools, CLI commands, file formats, QA-check catalogue | `docs/reference/` |
| **Tutorial** (learning) | "Get me started end-to-end" | learning by doing | the quickstart | `docs/quickstart.mdx` |

## How to tell them apart

- **Concept** describes the model and the *why* behind a design choice. No step-by-step. May include
  diagrams and tables of states/roles. If you're tempted to explain a trade-off, it belongs here.
- **Guide** is a goal-oriented sequence: "to do X, run these commands / ask the agent this." Show the
  minimum to accomplish the task and link to the Reference for the exhaustive list. Use `<Steps>`.
- **Reference** is exhaustive and dry: every tool, every flag, every field, in tables. No narrative,
  no opinions. Stable ordering. This is what an agent scrapes.
- **Tutorial** is the one happy path a newcomer follows top to bottom and succeeds. We keep this to
  the quickstart; don't proliferate tutorials.

## The common mistake

Putting the full option list inside a how-to guide, or a workflow narrative inside the reference.
Split them: the guide says "run `turjuman push --check` to gate CI" and links to the CLI reference;
the reference lists every flag. Minor duplication of a single command is fine; duplicating whole
tables is not.
