# Turjuman data model — redesign

> Internal design note, not published docs. This is the **target** data model for the redesign —
> the model as designed, not a migration from today's schema (there are no clients yet, so the
> rebuild is clean: delete the old, build the new correctly). Implementation sequencing is tracked
> separately.

## Objective

Classical translation-management systems are built around **human labor as the bottleneck**:
developers file translation jobs, copywriters translate string by string, reviewers score quality
against rubrics and thresholds, and someone polices terminology and consistency by hand. Every one
of those is a workflow, a queue, and a pile of schema.

Turjuman starts from a different premise: **an LLM does the translating, and the human's job shrinks
to two things — curate the context the model needs, and resolve the rare exception the model
escalates.** The data model's only job is to be the *minimal connective tissue* for that loop: hold
the context, run translate-and-judge, record the outcome, and remember what shipped.

So the redesign is as much a **deletion** as a construction. The machinery a classical TMS needs —
scoring subsystems, review rounds, quality thresholds, job management — is either **deleted** (the
agent re-judges for free, so a stored score is a frozen opinion) or **absorbed by the agent**
(effort, stakes, and thoroughness are prompt-time judgments, not schema). What remains is small on
purpose. **Simplicity is the feature, not a side effect.**

Structurally, what's left is a **versioned, branchable store of translations**, fed by a **context
layer that compounds** (every human decision and field correction becomes reusable context), and
driven by an **external agent over MCP**. Versioned is the spine; AI-translated is the labor;
context-fed is the moat.

### The governing constraint

> **Every human you remove from the loop, you must replace with the context they carried — made
> machine-readable.**

Humans in localization aren't only labor; they're **context-carriers**: brand voice, market
intuition, what a string means in situ, term consistency, a definition of "good." An LLM translates
fluently with zero context and is *fluently wrong*. The quality ceiling is how much tacit knowledge
you've externalized. That is why the **context layer** — not the string store — is where the
product's value compounds, even though the string store is where most of the *machinery* lives.

## The loop

Everything in the model exists to serve one loop. Read it once and the entities below explain
themselves.

1. **Define.** A developer (or an import) adds a `TranslationKey` — the source string plus whatever
   context is cheap to attach (description, where it appears, do-not-translate). No job, no
   assignment, no queue.
2. **Brief.** When a locale needs the string, the service resolves the **context cascade** for that
   `key × locale` (glossary, voice, examples, constraints) into a compact briefing and hands it to
   the agent over MCP. The app supplies context + structure; the agent supplies the model.
3. **Translate.** The agent writes a value. **Verifiable constraints** (placeholders, ICU, length,
   glossary survival) are enforced *inside* generation — reject-and-retry, like a compiler — so they
   are never a separate gate.
4. **Judge — the router.** The agent judges its own output and picks an exit: **accept** (confident
   → lifecycle `accepted`), **re-loop** (unsure → feed the objection back as context and translate
   again; regeneration is ~free), or **escalate** (irreducible judgment → a human decides). The
   human is the *terminal* exit, not a line-by-line reviewer.
5. **Record.** An accept appends an immutable **TranslationVersion** (the commit) and advances the
   cell's `head`. The living cell holds the working value + lifecycle; history holds every accepted
   value, non-destructively.
6. **Ship.** Export pins a branch and writes an immutable **Release** — the snapshot of what's live.
   "Live" is the latest Release, never a per-cell flag.
7. **Stay correct.** When the base string changes, dependent cells are marked `stale` and re-enter
   the router. When production reports a bad string (a **FieldReport**), the cell reopens and the fix
   re-enters the loop — and the human decision or correction **spawns reusable context** (an Example
   or GlossaryTerm), so the loop gets better without anyone "training" anything.

That is the whole product. The entity model is just the nouns this loop needs. **Branching** (below)
is the same loop running on parallel lines; **releases** are snapshots of it; **escalations and
field reports** are its two human/production touch-points.

## Project constraints (the shape the model must fit)

- **Self-hosted, open-source.** Serverless on AWS (Lambda Function URLs + a single DynamoDB table +
  GSIs + Streams→webhook). One `default` org for self-host.
- **MCP-first. LLMs are *only* the agent.** The app never bundles an LLM or a machine-translation
  engine. It supplies *context + structure + judgment scaffolding*; an external LLM/agent does all
  translating, driven through the **MCP server**. Any design that needs an in-app model (e.g.
  embedding-based retrieval) is invalid.
- **Thin developer CLI** for deterministic locale-file work (import/export). **REST is narrow** —
  file-shaped, automatable ops for CI. Everything else is MCP-only.
- **Deliberate non-goals:** no web UI, no built-in MT engine, no vendor marketplace.
- **YAGNI + one-liner solutions.** Minimal entities. All business logic + authorization live in one
  service layer; capabilities are declared once and projected to MCP/REST so the surfaces can't drift.
- **Auth:** static `Authorization: Bearer <api-key>` (SHA-256 hashed). RBAC: global
  OWNER/ADMIN/MEMBER + per-project MANAGER/EDITOR/DEVELOPER/VIEWER.

## Quality without scores

Review answers one question: *can we ship this string?* The answer is **a lifecycle state, not a
number.** This is where the redesign deletes the most classical-TMS weight.

There is deliberately **no quality score and no threshold.** A persisted `0..1` produced by an
external model the app doesn't own is a *frozen opinion* — invalid the moment the base or context
drifts — and the agent in the loop re-judges faithfulness and tone for free against the *current*
value every time it looks. So the model stores the **outcome** of judgment, not the judgment.

- **Two kinds of check, handled differently.**
  - **Verifiable** (placeholders, ICU, length, glossary survival, round-trip) → **not QA at all.**
    Constraints enforced *inside* generation (reject-and-retry), like a compiler — never a post-hoc
    gate. This is the real product, already half-built in `packages/schema/qa/`.
  - **Judgmental** (faithfulness, tone, naturalness) → the agent's in-context call at write time,
    recorded as the cell's **lifecycle**, nothing more.
- **Review is a router, not a gate** (loop step 4): *accept* / *re-loop* / *escalate*. Cheap
  regeneration means most "failures" re-enter the loop; the human is the **terminal** exit, for
  irreducible judgment only. (A project may instead require a human to flip `proposed → accepted` —
  one boolean, not a scoring subsystem.)
- **Effort is the agent's call, bounded by money.** "Be thorough on a legal line, one-shot a
  tooltip" is a *prompt instruction* the agent acts on with its own model; the app supplies only a
  per-run **budget ceiling** (`TranslationRun.budgetSpent`). No threshold, no `requiredSignals`
  matrix, no stakes knob — the agent judges stakes from context.

**What this deletes vs a classical TMS:** the score field, the threshold, the auto-approve config,
the MQM rubric/prompt machinery, review rounds, and the entire trust/calibration subsystem. The
signal-independence wisdom (a real user or a human decision outweighs a same-model self-report)
survives as a **prompt-engineering note** for whoever drives the agent — *not* schema.

## The root design principle

Almost every hard problem in this domain is **one mutable slot conflating distinct things**:
*identity* vs *display-name*, *last-accepted* vs *currently-live*, *the current value* vs *the base
revision it was translated from*. The model is built on one principle:

> **Separate the immutable/historical from the living/mutable, and separate identity from label.**

It earns two structures. "Live" is not a per-cell predicate — it's an immutable **Release**, so a
reopened cell or a re-export never silently changes what's deployed (the Release also anchors
rollback and field reports). And a translation records the base revision it was made *from*
(`sourceRef`), so a later edit to the source can mark it **stale**. The identity/label half is why a
key's identity is an opaque `id` and its `(namespace, name)` are *labels* — a rename or move is a
small **branch-scoped** metadata change (copy-on-write on the key's own row) that preserves all
history and, because translations reference the `id`, moves no translation data (see Branching and
Physical layout).

## The context cascade

Context is a **grid**, not a flat list: three nested scope tiers run vertically and locale runs
across them.

```
                 (all locales)   ar   de   fr ...
  PROJECT            ▓            ░    ░    ░
    NAMESPACE        ▓            ░    ░    ░
      KEY            ▓            ░    ░    ░
```

- `project ⊃ namespace ⊃ key` is **containment** (narrowest wins). **Locale is orthogonal** — a
  column multiplying every row. The real context space is `scope-tier × locale`.
- **Namespace is the "voice" tier** — tone/terminology cluster by feature-area (checkout =
  terse/transactional; errors = calm; emails = warm). **Namespace is OPTIONAL**: a key may have no
  namespace (cascade is `project → key`), or a namespace label with no context of its own.

**Merge operators — a property of the context *type*, not the tier:**

| Operator | Behavior | Used by |
|---|---|---|
| **override** (narrowest-wins) | the most specific tier replaces the value | voice/tone, formality, length limit |
| **union** (collect all tiers) | every tier contributes | glossary, do-not-translate, examples |
| **restrict** (most-restrictive, AND) | a parent rule a child can't loosen | compliance/legal, safety |

Those three are *folds over the cascade*. **Locale shaping** (plural, RTL, length-expansion) is
**not** a cascade operator — it's a deterministic post-step on the already-resolved bundle (it reuses
`plural.ts` + the format adapters), driven by `locale`, not authored as a context cell.

**Precedence ladder for override-type (highest→lowest), scope-major / locale-minor:**

```
1. key × locale      2. key × all      3. namespace × locale
4. namespace × all   5. project × locale   6. project × all
```

Union collects all six cells; restrict ANDs all six. **Resolution:** resolve the vertical column
per-operator → overlay locale cells → apply the locale-shaping post-step → emit `resolved bundle +
provenance`. A cross-tier override is recorded in provenance and **raises review depth** (a
deliberate exception deserves more scrutiny); a `restrict` conflict is a structural **escalation**.

## Entity model

Presented in **loop order** — the nouns each step needs. Every structural entity has an **immutable
opaque `id`**; its human coordinates (`name`, `code`, `(namespace, name)`) are *display labels*, not
identity. All child records reference ids.

### Scope — value object (the grid coordinate)

```
Scope { projectId; namespaceId?; keyId?; locale? }
```

Tier = narrowest populated of {key, namespace, project}; `locale` is orthogonal (absent = the
all-locales cell). One value object lets any context entity live at any cell.

### Identity & access

- **Org** — tenant boundary; self-host defaults to one `default`.
- **User** — `email`, `globalRole`.
- **ApiKey** — `userId`, `readOnly`, `expiresAt`; stored as SHA-256 hash.
- **Membership** — `userId`, `projectId`, `role`.

### Structure (the things translated)

- **Project** — `{ id, name, slug, baseLocale, targetLocales[], contextRevision }`. `contextRevision`
  is a monotonic project-wide counter bumped on any scoped context write (drives context-staleness).
- **Namespace** *(optional)* — `{ id, projectId, name, title, description, lifecycle }`. An opt-in
  context carrier; the "voice" tier.
- **Locale** — `{ id, projectId, code, lifecycle }`. Plural-category set derives from `code`.
- **TranslationKey** — `{ id, projectId, namespaceId?, name, description, tags, plural,
  lifecycle(active|deprecated), sourceRevision, introducedOnBranchId, noTranslate?, placements[] }`.
  `id` is identity; `(namespace, name)` are labels. `sourceRevision` = content hash + timestamp of
  the base value; it bumps when the base string is edited and fires the forward loop. `namespaceId`
  is nullable. `noTranslate?` marks a whole key that must survive verbatim (brand names, codes).
  **The key-definition row is copy-on-write per branch** (like a translation cell): a rename, move,
  or metadata edit lives on the branch and merges to `main` with the feature. A key introduced on a
  branch lives only in that branch's key partition until merged — so `introducedOnBranchId` is
  provenance + a merge hint, not a visibility filter. `placements` is a flat list of
  `{ surface, screen, role, order? }` situating the key in the UI — **briefing data only, never a
  `Scope`** (see the manifest, below).

`lifecycle` on Namespace/Locale/Key is **soft-delete** (active|deprecated/retired) so `Scope`
coordinates never dangle. Retiring cascades: dependent Translations go `stale` (not deleted), scoped
context cells archive, open Escalations auto-close with a typed resolution.

### The cell + its history

The cell follows a **commit + head-pointer** shape (git-like): the timeline of accepted values is an
immutable chain of **TranslationVersion**s (commits); the live cell points at the current one. This
is *temporal* history on one branch — orthogonal to branching, which is the *spatial* axis of
parallel lines.

- **Translation** — the living cell per `(branchId, keyId, locale)`:
  `{ branchId, keyId, locale, value, head, origin,
     lifecycle(untranslated|proposed|accepted|escalated|retired), stale, sourceRef, lockedByRunId? }`.
  **Copy-on-write:** a cell exists only on the branch that wrote it; an unwritten cell resolves by
  falling through to the parent branch (→ `main`).
  - `value` — the working draft (the only mutable text).
  - `lifecycle` — the **entire** review verdict: the agent self-accepts (`accepted`), flags for a
    human (`escalated`), or leaves `proposed` for a human to flip. No score field.
  - `head` — pointer to the current accepted **TranslationVersion** (the cell's branch-head; accepted
    text lives in history, not a mutable field). It **doubles as the concurrency + merge token**: an
    accept is a compare-and-swap on `head`, and a merge compares a branch's `head` against the
    `forkPoint`-recorded one. There is **no separate `version` integer** — the head pointer *is* the
    optimistic guard, and a run already owns the cell while working (`lockedByRunId`).
  - `sourceRef` — the base revision this cell was translated *from* (captured at loop start). `stale`
    is derived: `sourceRef != key.sourceRevision`.
  - `lockedByRunId?` — set while a run or escalation owns the cell (in-flight exclusivity).
- **TranslationVersion** *(append-only — a commit)* — the accepted-value chain per
  `(branchId, keyId, locale)`: `{ keyId, locale, value, origin, acceptedAt, acceptedBy|runRef,
     sourceRevision, prevVersionRef, supersededBy? }`. `prevVersionRef` links the chain; `revert`
  repoints the cell's `head` and links the triggering FieldReport. This is what makes "accepted"
  non-destructive.

### The write primitive

- **TranslationRun** — the single write primitive: one job that **applies a set of value-changes onto
  one branch** (assert `head`, write value, append a TranslationVersion, conflict → escalation),
  recording what the *external* MCP-driven agent did:
  `{ id, projectId, branchId, trigger(key.created|context-change|field-report|manual|merge),
     valueSource(agent|branch:<id>), scope|keyRefs[],
     status(queued|running|partial|done|failed|canceled), idempotencyKey,
     budgetSpent, cellsTotal, cellsDone, errors[], startedAt, finishedAt }`. A run writes into exactly
  one branch and gives idempotency against at-least-once webhooks, resumability, cancelation, and a
  per-run budget ceiling.
  - **A merge is just a run** with `trigger=merge` and `valueSource=branch:<child>` — it *transports*
    already-accepted values from a sibling branch instead of *generating* them, so it spends no
    budget. Same apply-and-conflict machinery; not a separate entity.

### Branching — the same loop on parallel lines

Branches are how variants, experiments, and unreleased features stay isolated — the
industry-standard TMS model (Crowdin / Phrase / Lokalise), adopted wholesale, but made
**ceremony-free**. A **branch** is a named, copy-on-write line of work over the project's keys and
translations. The **`main` branch always exists and is the safe root** — nothing experimental
touches it until a deliberate merge. Branching is **optional** (like namespace): most self-host users
only ever work on `main`, and for them it's invisible.

- **Branch** — `{ id, projectId, name, parentBranchId, forkPoint, status(open|merged|abandoned),
  createdBy, createdAt, mergedAt? }`. `main` has `parentBranchId = null`. `forkPoint` records the
  parent's state at creation — the merge baseline.

**Copy-on-write, not copy.** A branch stores only the cells and keys it actually touches — including
**edits to an existing key's definition** (rename, move, describe), not just new keys; every unwritten
read falls through to the parent (→ `main`). A feature branch with three changed strings is three
rows, not a clone — and `main` is untouched while you experiment. One mechanism covers all three
"variant" needs:

| Need | How |
|---|---|
| **Safe experimentation** | branch off `main`, translate freely, then merge or abandon — `main` stays shippable throughout |
| **Feature work** | a feature branch holds its new keys + renames; invisible to `main` until merge |
| **A/B testing** | two long-lived branches (`exp-a`, `exp-b`), each a variant value; deploy both, the pipeline routes traffic |

### What shipped

- **Release** *(immutable)* — the snapshot of what's live, written by the export path. **Pins one
  branch** and materializes its full resolved view (own cells + fall-through) at a moment in time:
  `{ id, projectId, branchId, label, locales[], status(open|frozen|superseded), createdBy, createdAt,
     entries:{ keyId, locale, versionRef }[] }`. **"Live" = the latest Release**, never a per-cell
  predicate. **Selection happens here, at the edge** — the store manages branches; the deploy
  pipeline decides which branch/Release bundles into which build (A/B routing and OTA/unreleased
  gating are export-stage choices, never state on the key). A Release may pin **any non-abandoned
  branch** (`open` or `merged`): branch `status` tracks the branch's own lifecycle, shippability is
  simply "has a Release," so a long-lived A/B branch is just an `open` branch with a Release.
  Enables rollback, reproducible CI export, and field-report anchoring.

### Context layer (each carries a `Scope` + a `lifecycle`)

Every context entity has `lifecycle: proposed|active|retired|archived` (default `active`); the
resolver collects only `active` cells and emits an `orphanedContext[]` provenance warning when a
Scope points at an archived or absent coordinate.

- **ContextRule** — the parametric carrier for every scoped, mergeable rule:
  `{ scope, kind, operator(override|union|restrict), payload, hard? }`. One entity, because these
  differ only by `kind` + `operator` + `payload` shape — the operator is *data*, not a class:
  - `voice` (tone / formality / register / audience / guidance) → **override**
  - `length`, `placeholdersRequired`, `format` (verifiable constraints, enforced inside generation) →
    **override** (**restrict** when `hard`)
  - `compliance` (must-include / must-avoid, legal / safety) → **restrict**
- **GlossaryTerm** *(kept distinct — typed per-locale payload)* —
  `{ scope, term, translations{locale→value}, doNotTranslate, caseSensitive }`. merge: **union**.
- **Example** *(kept distinct — retrieval machinery)* —
  `{ scope, sourceText, targetText, quality(gold|accepted), origin }`. The translation-memory /
  few-shot corpus. merge: **union** with deterministic retrieval (scope-proximity + quality + recency
  — **no embeddings**, per the constraints).

### Review records

The whole subsystem is two small things — a human exit and a comment thread; the cell's **lifecycle**
is the entire "is it good enough to ship" answer. No score, no ledger, no derived trust.

- **Escalation** *(slim)* — the human terminal exit: `{ target(translationRef|scopeRef), reason,
  assigneeUserId? (default project MANAGER), claimedBy?, claimedAt?, status(open|resolved), openedAt,
  resolvedAt?, resolution:{ valueChosen?, spawnedExampleRef?, spawnedGlossaryRef? } }`. Resolving sets
  the cell value + accepts, and may **spawn an `Example`/`GlossaryTerm`** so a human decision becomes
  reusable context rather than a dead-end approval. Claiming is a compare-and-swap on `claimedBy`;
  emits an `escalation.*` webhook.
- **Comment** *(threaded discussion)* — `{ target(keyRef + locale | scopeRef), authorId, body, at,
  parentId? }`. Where humans record the judgment a status flag can't carry (why a string is off, an
  agreed phrasing). **Shared across branches** — a comment attaches to the string `(key, locale)`,
  not to one branch's cell, exactly like glossary/voice/examples. One thread per string on every
  line, nothing to "merge"; threads graduate into shared `Example`s/`GlossaryTerm`s when confirmed.

### Feedback loop

- **FieldReport** *(slim)* — `{ locale, target(keyRef|text|scope), releaseRef?, description, status }`.
  Production saying "this shipped string is wrong" — the one fact the in-loop agent provably cannot
  know from its own context. Its `releaseRef` names the branch+version that was live, so the report is
  **branch-aware by reference**: the fix is a normal `TranslationRun` on whichever branch you choose
  (hotfix `main`, or a fix branch that merges), and copy-on-write carries a `main` fix to every open
  branch that never overrode the cell. It **reopens the targeted cell for review**
  (`accepted → proposed`, re-entering the router) and may spawn an `Example` (a correction) or a
  `GlossaryTerm` (a rule). No corroboration math, no dedup token, no trust fold — a self-hosted,
  API-key-gated tool has no anonymous mob to guard against.
- **Webhook** — `{ url, events, projectId }`. Drives the forward loop (new key / context change /
  field report → TranslationRun) and notifies on escalations and runs.

### Relationships

```
Org ─< Project ─< Namespace? ─< TranslationKey ─< Translation ─< TranslationVersion (commit chain)
                     │                  │               │           └─ head ──► current commit
                     │                  │               └─ Escalation     (cell-scoped; lifecycle = the verdict)
                     │                  └─ Comment (per key+locale; shared across branches)
                     ├─ Branch (main + parallel lines) ──(copy-on-write)── Key defs + Translation cells
                     └─ Release (pins ONE Branch; immutable shipped snapshot) ─► TranslationVersion
Project/Namespace/Key ──(Scope)── ContextRule · GlossaryTerm · Example
TranslationRun ──(one branch; trigger=generate|merge)──► Translation cells
FieldReport ──(via releaseRef → branch)──► reopen cell + fix-run ──► Example | GlossaryTerm
```

## Cross-cutting mechanisms

### Situational awareness — the TranslationManifest

The agent learns *where* a string sits in the UI from `Key.placements` (a flat
`{ surface, screen, role, order? }` list). The agent briefing is a **projection** of those placements
+ the resolved cascade into one legible, token-lean view — rendered on demand at a configurable
radius, never stored. Placement is **briefing data only**: it never enters a `Scope` and never carries
authoring power (see *Outside this model's boundary* for why a presentation scope axis breaks
`override`). It earns its keep for consumers that lack the repo — merge runs, field-report
re-translations, cheap reviewer models, CI export — and is biased to under-claim: a missing placement
degrades to the plain cascade briefing, a `stale` one is demoted to a hint, and a deleted key surfaces
as an orphan warning rather than a dangling pointer.

### Staleness — base changes invalidate, mainly

The dominant trigger is the only one incumbents bother with; a second is kept because the cascade is
the product. Both feed **one** invalidation fan-out that only **marks** cells — it never
auto-translates (re-translation always happens inside a budget-capped `TranslationRun`, which is the
natural back-pressure; no separate throttle is needed):

1. **Base string changed** *(primary)* — `TranslationKey.sourceRevision` bumps; cells where
   `sourceRef != sourceRevision` go `stale` and re-enter the router.
2. **Context changed** *(secondary)* — `Project.contextRevision` (one project-wide counter) bumps on
   any scoped context write; cells resolving through a changed scope may re-flag. Project-wide
   over-invalidates slightly — harmless, since re-translation is cheap and budgeted; go per-scope only
   if re-flagging ever proves noisy.

### Branching mechanics

- **Read (resolution):** a cell `(branch, key, locale)` — and a key's *definition* `(branch, key)` —
  is the branch's own row if present, else it falls through `parent → … → main`. A branch-introduced
  key simply isn't in `main`'s key partition, so it's invisible to `main` until merged — no read-time
  filter.
- **Merge:** a `TranslationRun{trigger=merge}` that applies a child branch's touched cells **and
  key-definition edits** (renames included) onto its parent. Conflict detection is **free**: a cell or
  key row whose parent advanced past the `forkPoint`-recorded baseline has moved on both sides →
  conflict, surfaced like any other escalation (human, or a re-loop with both values as context).
  Merge is not a separate path.
- **Merge against a moved base:** if `main`'s `sourceRevision` advanced under a branch cell, it is
  **both** a staleness event and a merge conflict — the *same* `sourceRevision`/`head` machinery,
  surfaced by *when you look*: during branch work the cell shows `stale` and re-enters the router; at
  merge time the advance past `forkPoint` surfaces as a conflict → escalation. (Because the key row
  carries `sourceRevision`, a base edit and its staleness marker travel together on the branch,
  consistent with the base value — itself a branch-scoped base-locale cell.)
- **Selection at the edge:** a Release pins one branch. The store only manages branches; the deploy
  pipeline chooses which one ships. So A/B, feature flags, and OTA gating add **no** per-key state.

### Concurrency

No separate optimistic-lock integer. Concurrency falls out of structure the model already has:

- **In-flight exclusivity:** a run claims the cell (`lockedByRunId`) while working.
- **Accept guard:** finalizing an accept is a **compare-and-swap on `head`** — write only if the
  cell's head is still the one this run read; a loser re-enters the loop with the winner's value as
  new context. No lost updates across multiple developers/teams on a cell.
- **Merge baseline:** the same `head` is the merge conflict token (vs the `forkPoint`-recorded one).
- **Run idempotency:** `TranslationRun.idempotencyKey` dedupes at-least-once webhook delivery; runs
  are resumable and cancelable.

### Lifecycle / state

Translation lifecycle is an explicit transition table including the return edges
`escalated → proposed|accepted` and a `retired → proposed` resurrection edge. Structural entities use
soft-delete `lifecycle`; context entities use `proposed|active|retired|archived`.

### Retention

Two append-only histories share the table — `TranslationVersion` and `Release`. Each is bounded by its
natural grain (one version per accept, one Release per export), so no cell grows an unbounded hot
partition.

### Recurring patterns

Two shapes recur; naming them removes special-casing and reveals the spine.

- **Judgment → context → fan-out.** When an *external* judgment lands — an Escalation resolved, a
  FieldReport filed — the same two things happen: optional **context** is spawned (an Example or
  GlossaryTerm), and the affected cells **re-enter the router** (reopen + re-stale). One verb, two
  triggers.
- **Append-only history.** `TranslationVersion` and `Release` share one *shape*: immutable, monotonic
  `seq`/`version`, `supersededBy`, never rewritten. They stay distinct entities (different grain and
  queries), but they're the immutable half of the governing principle applied twice.

## Physical layout — single DynamoDB table

The model lands on the existing `table + GSI1/2/3` topology with **no new GSI**. Translations are
partitioned by locale and GSI3 flips that to read one key across locales. Branching threads in as
**one extra segment** (`#BR#<branchId>`) that scopes **both** translation cells **and key
definitions**; all cell/version/comment/release rows are keyed by the key's opaque **`keyId`** (not
`(namespace, name)`). Because key definitions are copy-on-write per branch, a rename/move/edit is a
small branch-local change that merges to `main` — and since translations reference `keyId`, none of
them move when a name changes. A per-branch `name→id` lookup keeps import/export and list-by-namespace
working by name.

```
Branch (config)       PK = PROJECT#<pid>                 SK = BRANCH#<branchId>   (parent, forkPoint, status)
Key definition (COW)  PK = PROJ#<pid>#BR#<branchId>       SK = KEY#<keyId>         (name, namespaceId, sourceRevision, …)
Name → id lookup(COW) PK = PROJ#<pid>#BR#<branchId>       SK = KEYNAME#<ns>#<name> → keyId   (import/export, list-by-ns)
Translation cell      PK = PROJ#<pid>#BR#<branchId>#LOC#<code>   SK = KEY#<keyId>
GSI3 (key→locales)    GSI3PK = PROJ#<pid>#BR#<branchId>#KEY#<keyId>   GSI3SK = LOC#<code>
History               same cell partition, SK-prefixed:
                        SK = KEY#<keyId>            ← live cell (mutable; lifecycle state lives here)
                        SK = KEY#<keyId>#VER#<seq>  ← TranslationVersion (append-only)
Comment (branch-free) PK = PROJ#<pid>#CMT#LOC#<code>   SK = KEY#<keyId>#<seq>   ← shared across branches
Release (immutable)   PK = PROJ#<pid>#REL#<releaseId>   SK = META | KEY#<keyId>#<code>
Context (rule/glossary/example)   logically scoped by `Scope`; partition layout left to implementation
```

- **`main` is not special** — it's `branchId = "main"` baked into the PK; key definitions and cells
  alike fall through to it.
- **Copy-on-write read** = at most *depth* point-reads up the parent chain (branch trees are shallow);
  a missing branch row falls through to the parent partition. No scan, no join.
- **Merge / export** = query the branch's key + locale partitions, overlay onto the parent's. Conflict
  detection compares the branch's own `head` (or key row) vs the `forkPoint` baseline — no new data.
- **Branch-introduced keys need no special-casing:** a new key's definition lives in the branch's key
  partition and not in `main`'s, so `main`'s listing excludes it by construction. A rename writes the
  new `name→id` on the branch and tombstones the old name so fall-through doesn't resurrect it; merge
  carries both to `main`.

| Access pattern | How | New GSI? |
|---|---|---|
| Read a cell on a branch | `GET PROJ#pid#BR#br#LOC#code / KEY#keyId` | no |
| COW fall-through | ≤ depth point-reads up the parent chain | no |
| Key across locales on a branch | GSI3 + `BR#` segment | reuses GSI3 |
| List keys on a branch | query `PROJ#pid#BR#br` `begins_with KEY#` (COW fall-through) | no |
| All cells on a branch (merge/export) | query the branch's locale partitions | no |
| Cell history (versions) | query cell partition by SK prefix | no |
| Resolve a key by name on a branch | `GET PROJ#pid#BR#br / KEYNAME#ns#name` → keyId (fall-through) | no |
| Comments on a (key, locale) | query `PROJ#pid#CMT#LOC#code` `begins_with KEY#keyId` | no |
| List branches | query project partition `begins_with BRANCH#` | no |
| What shipped | query the Release partition | no |

**Net cost of the redesign in storage terms:** one new entity (`Branch`), one PK segment
(`#BR#<id>`) now scoping **both** cells and key definitions, and `keyId`-based addressing with a
per-branch `name→id` lookup. The 3-GSI deploy topology is untouched.

## Decisions resolved

These were open in the prior draft; resolved so this version is final.

1. **Re-loop storm — no special machinery.** Staleness only *marks* cells; re-translation happens only
   inside a budget-capped `TranslationRun`. That run + budget ceiling is the back-pressure. Revisit
   only if a real install ever sees churn.
2. **`contextRevision` — one project-wide counter.** Simple; over-invalidates a little, which is
   harmless because re-translation is cheap and budgeted. Go per-scope only if re-flagging proves noisy.
3. **Branch status / A-B — no new status.** A Release may pin any non-abandoned branch (`open` or
   `merged`); status tracks the branch's own lifecycle, shippability is "has a Release." A long-lived
   A/B branch is just an `open` branch with a Release.
4. **Merge against a moved base — both.** During branch work the cell is `stale` and re-enters the
   router; at merge time the base/head advance past the `forkPoint` surfaces as a conflict → escalation.
   Same machinery, different surfacing.
5. **Key identity — `keyId`, not name.** Cells, versions, and comments are keyed by `KEY#<keyId>`; a
   per-branch `name→id` lookup serves import/export and list-by-namespace. Honors "separate identity
   from label"; a rename moves no translation data.
6. **Context physical layout — left to implementation.** The design fixes the logical model (`Scope` +
   cascade); it does not pin context records to a partition layout. That's a build-time call.
7. **Key definitions are branch-scoped (copy-on-write).** Resolves the prose/physical contradiction in
   favor of the prose: a rename/move/edit to an existing key lives on the branch and merges to `main`
   atomically with the feature (divergent edits conflict like values). `keyId` keeps it cheap —
   translations never move — and branch-introduced keys then need no read-time filter (their
   definition simply isn't in `main`'s partition). A rename is **signaled explicitly** (an MCP rename
   op or a `push --rename` directive, applied to the target branch); auto-detection by source text is
   avoided as non-deterministic.

## Adjacent changes folded into this rebuild

Not data-model changes — surface simplifications that share the redesign's thesis (*delete the
classical-TMS weight; simplicity is the feature*) and ride along because the rebuild already touches
everything. The operation registry stays the single source of capability throughout; these only
change how it's *projected*.

- **Collapse the two MCP surfaces into one — drop classic, keep code, call it just "the MCP."**
  Today `mcp-server` projects two surfaces: *classic* (default — one flat tool per operation) and
  *code* (`?mode=code` — the agent writes JS/TS against the SDK registry in a QuickJS sandbox, with
  `search`/`describe` for discovery). **Cut classic. The code surface becomes the only one, and stops
  being a "mode" — there is just the MCP.** The `?mode=` switch and the "classic/code" naming go
  away; `packages/sandbox` (`runCode`) and `packages/knowledge` (`search`/`describe`) become the
  non-optional core of the one server, not an opt-in. Why: a single composable surface — write code
  over the whole registry — strictly dominates N flat tools for an agent, it's the natural fit for the
  translate-and-judge loop, and one projection can't drift from a second. The per-operation tool
  list, the mode router, and every doc/CLI reference to modes are deleted with it.

## Outside this model's boundary

Concepts that are real but belong to a *different* model — a capability, an RBAC tier, an external
pipeline — rather than this data model. Noted so the boundary is explicit:

- **Branch-scoped context (and comments)** — per-branch `ContextRule` overrides, or a comment pinned to
  one branch's value. In this model both context and comments are **shared across branches** (industry
  keeps glossary global); `Scope` and the comment target each have a clean place to add a `branchId` if
  either ever needs the branch axis.
- **Presentation as a stored UI model / scope axis** — a nested interface tree
  (`surface ⊃ screen ⊃ region ⊃ component`) inside Turjuman, or a presentation tier added to `Scope`.
  **Cut.** A second containment chain breaks `override`: `namespace:checkout` and `screen:payment` are
  *incomparable*, so "narrowest wins" has no defined winner and the precedence ladder loses its total
  order. (Locale survives as a second axis only because it is a point-selector, not a chain.) Where a
  string sits in the UI is therefore **briefing data, never an override target** — the flat
  `Key.placements` hint, rendered into the agent briefing.
- **Measured-trust subsystem** — a folded `Trust` score over a `ReviewSignal` ledger,
  signal-independence ranking, a versioned `Calibration` (judge-of-the-judge), `ReviewRound`, and a
  stakes-buy-depth economics layer. **Cut.** The judge is an *external* model the app doesn't own, so a
  persisted `0..1` is a frozen opinion; no shipping TMS models the heavy version; and the agent
  re-derives faithfulness/tone for free against the *current* value. The residue kept here is a 3-state
  cell lifecycle, the accept/re-loop/escalate router, slim `Escalation`, slim `FieldReport`, `Comment`,
  and verifiable-constraints-in-generation — **no score, no threshold.** Add a score only the day a
  human genuinely can't tell the iffy strings from the good ones without one.
- **Agent-driven auto-merge** — a *capability*, not model state: merge conflicts are surfaced as
  escalations (or re-loops); how they get resolved is the service layer's concern.
- **NamespaceMembership** — an optional third RBAC tier for shared-namespace ownership across teams.
- **Reporter** as a full entity, per-plural-category review state, and Example retrieval ranking beyond
  the deterministic default.
- **Hard rule:** any retrieval or ranking reaching for embeddings breaches *no in-app model*. Retrieval
  stays deterministic (scope-proximity + quality + recency).
