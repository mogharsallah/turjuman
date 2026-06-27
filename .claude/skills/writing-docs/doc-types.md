# Page types — Diátaxis as the model, Mintlify content types as the artifact

Use **Diátaxis** as your *mental model* for what a page is for, and Mintlify's **content templates**
as the concrete starting skeleton. They agree on the four jobs a page can do; they differ on how
strict to be. This file reconciles them.

## The four jobs (Diátaxis ↔ Mintlify)

| Diátaxis job | Mintlify's name | Reader is… | Answers | Turjuman examples | Lives under | Template |
|---|---|---|---|---|---|---|
| **Explanation** | Explanation | understanding | "Why / how does it work?" | architecture, lifecycle, roles & permissions | `concepts/` | `templates/concept.mdx` |
| **How-to** | How-to Guide | doing a task | "How do I do X?" | translate with MCP, sync with the CLI, run QA, webhooks, connect a client | `guides/` (+ the `self-hosting/` tab for operator how-tos) | `templates/guide.mdx` |
| **Reference** | Reference | looking up | "What exactly is the tool/flag/field?" | MCP tools, CLI commands, file formats, QA checks | `reference/` | `templates/reference.mdx` |
| **Tutorial** | Tutorial | learning end-to-end | "Get me started, hands-on" | the quickstart | `quickstart.mdx` | `templates/tutorial.mdx` |

> **Naming note.** The current repo and older Diátaxis material say *Concept* and *Guide*; Mintlify
> says *Explanation* and *How-to Guide*. Same quadrants, different labels. We keep the directory names
> `concepts/` and `guides/` (and call them Concept / Guide pages) — just know they map to Mintlify's
> Explanation / How-to.

## How to tell them apart

- **Concept / Explanation** describes the model and the *why* behind a design choice. No step-by-step.
  Diagrams (`<Frame>`/Mermaid) and tables of states/roles belong here. If you're explaining a
  trade-off, it goes here. Structure: define the concept → how it works → why this design → when to
  use it → relationship to other features → common misconceptions → further reading.
- **Guide / How-to** is a goal-oriented sequence: "to do X, run these / ask the agent this." Show the
  minimum to accomplish the task; use `<Steps>`; link to the Reference for the exhaustive list.
  Structure: opening line → prerequisites → the steps → verify the result → troubleshooting → related.
- **Reference** is exhaustive and dry: every tool, flag, field, default, limit, edge case, in tables
  or `<ParamField>`/`<ResponseField>`. No narrative, no opinions, stable ordering. This is what an
  agent scrapes.
- **Tutorial** is the one happy path a newcomer follows top to bottom and succeeds. We keep this to
  the quickstart — don't proliferate tutorials.

## Strict Diátaxis vs. Mintlify — where they diverge (and who wins)

The old skill enforced *strict* Diátaxis: "every page is exactly one of four types; never mix them."
**Mintlify is deliberately looser, and on this point Mintlify wins:**

- Mintlify: *"In practice, pages often mix types — especially getting started content that blends
  tutorial and how-to."*
- Mintlify: *"The types describe needs users might have, not a checklist you must complete."*

So the working rule is:

- **Default to one primary job per page.** A page that tries to be all four at once is the common
  failure — it scatters. Pick the reader's main need and lead with it.
- **Blend deliberately when a real reader need spans two jobs.** A quickstart is a tutorial that
  necessarily contains how-to steps; an overview/landing page mixes orientation with navigation.
  That's fine — it's intentional, not muddle.
- **The anti-pattern isn't "two jobs on one page" — it's "the wrong content in the wrong place."**
  Don't bury the full flag list inside a guide; don't put a workflow narrative inside the reference.
  Minor duplication of a single command is fine; duplicating whole tables is not — cross-link.

## Mintlify content types beyond the four

Mintlify also names a few *informal* page kinds that are blends or specializations rather than new
quadrants — no separate template, just patterns:

- **Getting started / Quickstart** — a blend of tutorial + how-to. (Turjuman: `quickstart.mdx`.)
- **Overview / Landing** — orientation + a navigation hub of `<Card>`s. (Turjuman: `introduction.mdx`,
  `self-hosting/overview.mdx`; see `templates/landing.mdx`.)
- **Changelog** — chronological `<Update>` entries (often `mode: "center"`). Turjuman tracks shipped
  vs. planned status in `ROADMAP.md` at the repo root, not a docs page.
- **FAQ / Troubleshooting** — `<AccordionGroup>` of question → answer.

Reach for these patterns when they fit; they don't replace the four jobs, they compose them.
