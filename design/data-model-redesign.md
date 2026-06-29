# Turjuman data model — from scratch

> Internal design note, not published docs. It models Turjuman as a *context + judgment
> manager* (not a *string + state manager*) and defines the entity model to build on.
> This is the model as designed, not a migration from today's schema — implementation
> sequencing is out of scope here.

## Governing law

> **Every human you remove from localization, you must replace with the context they
> carried — made machine-readable.** Humans in this pipeline aren't labor; they're
> context-carriers (brand voice, market intuition, what a string means in situ, term
> consistency, a definition of "good"). An LLM translates fluently with zero context and
> is fluently wrong. The quality ceiling is how much tacit knowledge you've externalized.

**Center of gravity:** *context manager*. Strings are the cheap part. The moat is the
institutional-knowledge (context) layer that feeds the agent — glossary, voice, examples, do-not-translate.
The human's role is to **curate that context and resolve the exceptions an agent escalates**, not to
translate or review line by line. (Quality control itself stays deliberately boring — see pillar 2;
the elaborate "measured-trust" machinery an earlier draft carried was cut, *Outside this model's
boundary*.)

## Project constraints (the shape the model must fit)

- **Self-hosted, open-source.** Serverless on AWS (Lambda Function URLs + a single
  DynamoDB table + GSIs + Streams→webhook). One `default` org for self-host.
- **MCP-first. LLMs are *only* the agent.** The app never bundles an LLM or a
  machine-translation engine. The app supplies *context + structure + judgment
  scaffolding*; an external LLM/agent does all translating, driven through the **MCP
  server**. There is no in-app model — any design that needs one (e.g. embedding-based
  retrieval) is invalid.
- **Thin developer CLI** for deterministic locale-file work (import/export). **REST is
  narrow** — file-shaped, automatable ops for CI. Everything else is MCP-only.
- **Deliberate non-goals:** no web UI, no built-in MT engine, no vendor marketplace.
- **YAGNI + one-liner solutions.** Minimal entities. All business logic + authorization
  live in one service layer; capabilities are declared once and projected to MCP/REST so
  the surfaces can't drift.
- **Auth:** static `Authorization: Bearer <api-key>` (SHA-256 hashed). RBAC: global
  OWNER/ADMIN/MEMBER + per-project MANAGER/EDITOR/DEVELOPER/VIEWER.

## The two pillars

### 1. Context cascade

Context is a **grid**, not a flat list: three nested scope tiers run vertically and locale
runs across them.

```
                 (all locales)   ar   de   fr ...
  PROJECT            ▓            ░    ░    ░
    NAMESPACE        ▓            ░    ░    ░
      KEY            ▓            ░    ░    ░
```

- `project ⊃ namespace ⊃ key` is **containment** (narrowest wins). **Locale is orthogonal**
  — a column multiplying every row. The real context space is `scope-tier × locale`.
- **Namespace is the "voice" tier** — tone/terminology cluster by feature-area (checkout =
  terse/transactional; errors = calm; emails = warm). **Namespace is OPTIONAL**: a key may
  have no namespace (cascade is `project → key`), or a namespace label with no context of
  its own (an empty middle cell).

**Merge operators — a property of the context *type*, not the tier:**

| Operator | Behavior | Used by |
|---|---|---|
| **override** (narrowest-wins) | the most specific tier replaces the value | voice/tone, formality, length limit |
| **union** (collect all tiers) | every tier contributes | glossary, do-not-translate, examples |
| **restrict** (most-restrictive, AND) | a parent rule a child can't loosen | compliance/legal, safety |

Those three are *folds over the cascade*. **Locale shaping** (plural, RTL, length-expansion) is
**not** a cascade operator — it's a deterministic post-step applied to the already-resolved bundle
(it reuses `plural.ts` + the format adapters), driven by `locale`, not authored as a context cell.

**Precedence ladder for override-type (highest→lowest), scope-major / locale-minor:**

```
1. key × locale      2. key × all      3. namespace × locale
4. namespace × all   5. project × locale   6. project × all
```

Union collects all six cells; restrict ANDs all six. **Resolution:** resolve the vertical column
per-operator → overlay locale cells → apply the locale-shaping post-step → emit `resolved bundle +
provenance`. A cross-tier override is recorded in provenance and **raises review depth** (a
deliberate exception deserves more scrutiny); a `restrict` conflict is a structural **escalation**.

### 2. Review/QA — just a status flag

Review answers one question: *"can we ship this string?"* The answer is **a lifecycle state, not a
number.** There is no quality score and no threshold: a persisted 0..1 produced by an external model
the app doesn't own is a frozen opinion, and the agent in the loop re-judges faithfulness/tone for
free against the *current* value every time it looks. So we store the **outcome of that judgment, not
the judgment.**

- **Two kinds of check, handled differently.**
  - **Verifiable** (placeholders, ICU, length, glossary survival, round-trip) → **not QA at all.**
    **Constraints enforced *inside* generation** (reject-and-retry), like a compiler — never a
    post-hoc gate. This is the real product, already half-built in `packages/schema/qa/`.
  - **Judgmental** (faithfulness, tone, naturalness) → the agent's in-context call at write time; its
    result is recorded as the cell's **lifecycle**, nothing more.
- **Review is a router, not a gate** — the agent picks the exit as it writes: *accept* (confident →
  `accepted`) / *re-loop* (feed the objection back as new context and re-translate) / *escalate*
  (unsure → `escalated`, a human decides). Cheap re-translation means most "failures" re-enter the
  loop; the human is the **terminal** exit, for irreducible judgment only. This router is the one
  genuinely AI-native move: when regeneration is ~free you loop, you don't gate. (A project may
  instead require a human to flip `proposed → accepted` rather than letting the agent self-accept —
  one boolean, not a scoring subsystem.)
- **Effort allocation is the agent's call, bounded by money.** "Be thorough on a legal line, one-shot
  a tooltip" is a *prompt instruction* the agent acts on with its own model; the app supplies only a
  per-run **budget ceiling** (`TranslationRun.budgetSpent`, a cost guard the agent won't self-enforce).
  No threshold, no `requiredSignals` matrix, no stakes knob — the agent judges stakes from context.

The signal-independence wisdom (a real user or a human decision outweighs same-model self-report)
survives as a **prompt-engineering note** for whoever drives the agent — *not* schema.

## The root design principle

Almost every hard problem in this domain is **one mutable slot conflating distinct things**:
*identity* vs *display-name*, *last-accepted* vs *currently-live*, *the current value* vs *the
base revision it was translated from*. The model is built on one principle:

> **Separate the immutable/historical from the living/mutable, and separate identity from
> label.**

The principle still earns two structures after the trust machinery is cut, on simpler grounds.
"Live" is not a per-cell predicate — it's an immutable **Release**, so a reopened cell or a
re-export never silently changes what's deployed; the Release is also the anchor for rollback and
field reports. And a translation records the base revision it was made *from* (`sourceRef`), so a
later edit to the source can mark it **stale** — the immutable-vs-living split applied to the one
staleness trigger that's unambiguously real.

## Entity model

### Scope — value object (the grid coordinate)

```
Scope { projectId; namespace?; keyId?; locale? }
```

Tier = narrowest populated of {key, namespace, project}; `locale` is orthogonal (absent =
the all-locales cell). One value object lets any context entity live at any cell.

### Identity & access

- **Org** — tenant boundary; self-host defaults to one `default`.
- **User** — `email`, `globalRole`.
- **ApiKey** — `userId`, `readOnly`, `expiresAt`; stored as SHA-256 hash.
- **Membership** — `userId`, `projectId`, `role`.

### Structure & identity

Every structural entity has an **immutable opaque `id`**; its human coordinates
(`name`, `code`, `(namespace, name)`) are *display labels*, not identity. All child records
reference ids, so a rename or move is a metadata update that preserves history. Import/export
keys by name; the service layer maps name → id.

- **Project** — `{ id, name, slug, baseLocale, targetLocales[], contextRevision }`. `contextRevision`
  is a monotonic counter bumped on any scoped context write (drives staleness, below).
- **Namespace** *(optional)* — `{ id, projectId, name, title, description, lifecycle }`. An
  opt-in context carrier; the "voice" tier.
- **Locale** — `{ id, projectId, code, lifecycle }`. Plural-category set derives from `code`.
- **TranslationKey** — `{ id, projectId, namespaceId?, name, description, tags, plural,
  lifecycle(active|deprecated), sourceRevision, introducedOnBranchId, noTranslate?,
  placements[] }`. A key introduced on a branch is invisible to `main` until merged.
  `sourceRevision` = content hash + timestamp of the base value; it bumps when the base string
  is edited and fires the forward loop. `namespaceId` is nullable. `noTranslate?` marks a
  whole key that must survive verbatim (brand names, codes). `placements` is a flat list of
  `{ surface, screen, role, order? }` situating the key in the UI — **briefing data only,
  never a `Scope`** (the manifest, below).

`lifecycle` on Namespace/Locale/Key is **soft-delete** (active|deprecated/retired) so `Scope`
coordinates never dangle. Retiring cascades: dependent Translations go `stale` (not deleted),
scoped context cells archive, open Escalations auto-close with a typed resolution.

### Branching — parallel lines of translation work

Branches are how variants, experiments, and unreleased features stay isolated — the
industry-standard TMS model (Crowdin / Phrase / Lokalise), adopted wholesale. Translation keys
are version-controlled like code: a **branch** is a named, copy-on-write line of work over the
project's keys and translations. The **`main` branch always exists and is the safe root** —
nothing experimental touches it until a deliberate merge. Branching is **optional** (like
namespace): most self-host users only ever work on `main`.

- **Branch** — `{ id, projectId, name, parentBranchId, forkPoint, status(open|merged|abandoned),
  createdBy, createdAt, mergedAt? }`. `main` has `parentBranchId = null`. `forkPoint` records the
  parent's state at creation — the merge baseline.

**Copy-on-write, not copy.** A branch stores only the cells and keys it actually touches; every
unwritten read falls through to the parent (→ `main`). A feature branch with three changed
strings is three rows, not a clone of the project — and `main` is untouched while you experiment.
One mechanism covers all three "variant" needs:

| Need | How |
|---|---|
| **Safe experimentation** | branch off `main`, translate freely, then merge or abandon — `main` stays shippable throughout |
| **Feature work** | a feature branch holds its new keys (`introducedOnBranchId`); invisible to `main` until merge |
| **A/B testing** | two long-lived branches (`exp-a`, `exp-b`), each a variant value; deploy both, the pipeline routes traffic |

### Translation & its history

The cell follows a **commit + head-pointer** shape (git-like): the timeline of accepted values is
an immutable chain of **TranslationVersion**s (commits); the live cell points at the current one.
This is *temporal* history on one branch — orthogonal to branching, which is the *spatial* axis of
parallel lines. (So the two are not redundant: branch = which line, commit chain = the timeline on
that line.)

- **Translation** — the living cell per `(branchId, keyId, locale)`:
  `{ branchId, keyId, locale, value, head, origin,
     lifecycle(untranslated|proposed|accepted|escalated|retired), stale,
     sourceRef, lockedByRunId? }`. **Copy-on-write:** a cell exists only on the branch that wrote
  it; an unwritten cell resolves by falling through to the parent branch (→ `main`).
  - `value` — the working draft (the only mutable text).
  - `lifecycle` — the **entire** review verdict: the agent self-accepts (`accepted`), flags for a
    human (`escalated`), or leaves `proposed` for a human to flip. No score field.
  - `head` — pointer to the current accepted **TranslationVersion** (the cell's branch-head;
    replaces any `approvedValue` slot — accepted text lives in history, not a mutable field). It
    **doubles as the concurrency + merge token**: an accept is a compare-and-swap on `head`, and a
    merge compares a branch's `head` against the `forkPoint`-recorded one. There is **no separate
    `version` integer** — the head pointer *is* the optimistic guard, and a run already owns the
    cell while working (`lockedByRunId`).
  - `sourceRef` — the base revision this cell was translated *from* (captured at loop start,
    not re-read at write time). `stale` is derived: `sourceRef != key.sourceRevision`.
  - `lockedByRunId?` — set while a run or escalation owns the cell (in-flight exclusivity).
- **TranslationVersion** *(append-only — a commit)* — the accepted-value chain per
  `(branchId, keyId, locale)`: `{ keyId, locale, value, origin, acceptedAt, acceptedBy|runRef,
     sourceRevision, prevVersionRef, supersededBy? }`. `prevVersionRef` links the
  chain; `revert` repoints the cell's `head` and links the triggering FieldReport. This is what
  makes "accepted" non-destructive.

### What shipped

- **Release** *(immutable)* — the snapshot of what's live, written by the export path. **Pins
  one branch** and materializes its full resolved view (own cells + fall-through) at a moment in
  time: `{ id, projectId, branchId, label, locales[], status(open|frozen|superseded), createdBy,
     createdAt, entries:{ keyId, locale, versionRef }[] }`.
  **"Live" = the latest Release**, never a per-cell predicate — so a reopened cell or a re-export
  doesn't silently change what's deployed. **Selection happens here, at the edge** — the
  store manages branches; the deploy pipeline decides which branch/Release bundles into which
  build (A/B routing and OTA/unreleased gating are export-stage choices, never state on the key).
  Enables rollback, reproducible CI export, and field-report anchoring (a report names the
  Release it was seen in).

### The agent loop

- **TranslationRun** — the single write primitive: one job that **applies a set of value-changes
  onto one branch** (assert `head`, write value, append a TranslationVersion, conflict →
  escalation), recording what the *external* MCP-driven agent did (no in-app model):
  `{ id, projectId, branchId, trigger(key.created|context-change|field-report|manual|merge),
     valueSource(agent|branch:<id>), scope|keyRefs[],
     status(queued|running|partial|done|failed|canceled), idempotencyKey,
     budgetSpent, cellsTotal, cellsDone, errors[], startedAt, finishedAt }`. A run writes into
  exactly one branch and gives idempotency against at-least-once webhooks, resumability,
  cancelation, and a per-run budget ceiling.
  - **A merge is just a run** with `trigger=merge` and `valueSource=branch:<child>` — it
    *transports* already-accepted values from a sibling branch instead of *generating* them, so it
    spends no budget and transports accepted values rather than earning them fresh. Same apply-and-conflict machinery;
    not a separate entity.

### Context layer (each carries a `Scope` + a `lifecycle`)

Every context entity has `lifecycle: proposed|active|retired|archived` (default `active`); the
resolver collects only `active` cells and emits an `orphanedContext[]` provenance warning when
a Scope points at an archived or absent coordinate.

- **ContextRule** — the parametric carrier for every scoped, mergeable rule:
  `{ scope, kind, operator(override|union|restrict), payload, hard? }`. One entity, because these
  differ only by `kind` + `operator` + `payload` shape — the operator is *data*, not a class. Its
  kinds span the cascade:
  - `voice` (tone / formality / register / audience / guidance) → **override**
  - `length`, `placeholdersRequired`, `format` (verifiable constraints, enforced inside generation) → **override** (**restrict** when `hard`)
  - `compliance` (must-include / must-avoid, legal / safety) → **restrict**
- **GlossaryTerm** *(kept distinct — typed per-locale payload)* —
  `{ scope, term, translations{locale→value}, doNotTranslate, caseSensitive }`. merge: **union**.
  (Do-not-translate is a flag on this entity.)
- **Example** *(kept distinct — retrieval machinery)* —
  `{ scope, sourceText, targetText, quality(gold|accepted), origin }`. The translation-memory /
  few-shot corpus. merge: **union** with deterministic retrieval (scope-proximity + quality +
  recency — **no embeddings**, per the constraints).

### Review records

The whole subsystem is two small things — a human exit and a comment thread; the cell's **lifecycle**
is the entire "is it good enough to ship" answer. No score, no ledger, no derived trust, no versioned
judge (see *Outside this model's boundary* for why those were cut).

- **Escalation** *(slim)* — the human terminal exit: `{ target(translationRef|scopeRef),
  reason, assigneeUserId? (default project MANAGER), claimedBy?, claimedAt?, status(open|resolved),
  openedAt, resolvedAt?, resolution:{ valueChosen?, spawnedExampleRef?, spawnedGlossaryRef? } }`.
  Resolving sets the cell value + accepts, and may **spawn an `Example`/`GlossaryTerm`** so a human
  decision becomes reusable context rather than a dead-end approval. Claiming is a compare-and-swap on
  `claimedBy`; emits an `escalation.*` webhook.
- **Comment** *(the market's actual judgment-capture mechanism — threaded discussion)* —
  `{ target(keyRef + locale | scopeRef), authorId, body, at, parentId? }`. Where humans record the
  judgment a status flag can't carry (why a string is off, an agreed phrasing). **Shared across
  branches** — a comment attaches to the string `(key, locale)`, not to one branch's cell, exactly
  like glossary/voice/examples (context is global in this model). So there is one thread per string
  on every line, nothing to "merge", and threads graduate into shared `Example`s/`GlossaryTerm`s
  when confirmed. Every shipping TMS has this, and the trust ledger was, in part, a baroque
  substitute for it.

### Feedback loop

- **FieldReport** *(slim)* — `{ locale, target(keyRef|text|scope), releaseRef?, description, status }`.
  Production saying "this shipped string is wrong" — the one fact the in-loop agent provably cannot
  know from its own context. Its `releaseRef` names the branch+version that was live, so the report
  is **branch-aware by reference**: the fix is a normal `TranslationRun` on whichever branch you
  choose (hotfix `main`, or a fix branch that merges), and copy-on-write carries a `main` fix to every
  open branch that never overrode the cell. It **reopens the targeted cell for review**
  (`accepted → proposed`, re-entering the router) and may spawn an `Example` (a correction) or a
  `GlossaryTerm` (a rule). No corroboration math, no dedup token, no trust fold — a self-hosted,
  API-key-gated tool has no anonymous mob to guard against; add a corroboration threshold only if a
  real install ever needs one.
- **Webhook** — `{ url, events, projectId }`. Drives the forward loop (new key / context change
  / field report → TranslationRun) and notifies on escalations and runs.

### Relationships

```
Org ─< Project ─< Namespace? ─< TranslationKey ─< Translation ─< TranslationVersion (commit chain)
                     │                  │               │           └─ head ──► current commit
                     │                  │               └─ Escalation     (cell-scoped; lifecycle = the verdict)
                     │                  └─ Comment (per key+locale; shared across branches)
                     ├─ Branch (main + parallel lines) ──(copy-on-write)── Translation/Key cells
                     └─ Release (pins ONE Branch; immutable shipped snapshot) ─► TranslationVersion
Project/Namespace/Key ──(Scope)── ContextRule · GlossaryTerm · Example
TranslationRun ──(one branch; trigger=generate|merge)──► Translation cells
FieldReport ──(via releaseRef → branch)──► reopen cell + fix-run ──► Example | GlossaryTerm
```

## Cross-cutting mechanisms

### Situational awareness — the TranslationManifest

The agent learns *where* a string sits in the UI from `Key.placements` (a flat
`{ surface, screen, role, order? }` list). The agent briefing is a **projection** of those
placements + the resolved cascade into one legible, token-lean view — rendered on demand at a
configurable radius, never stored. Placement is **briefing data only**: it never enters a
`Scope` and never carries authoring power (see *Outside this model's boundary* for why a
presentation scope axis breaks `override`). It earns its keep for the consumers that lack the
repo — merge runs, field-report re-translations, cheap reviewer models, CI export — and is
biased to under-claim: a missing placement degrades to the plain cascade briefing, a `stale`
one is demoted to a hint (never fed to the constraint machinery), and a deleted key surfaces
as an orphan warning rather than a dangling pointer.

### Staleness — base changes invalidate, mainly

The dominant trigger is the only one incumbents bother with; a second is kept because the cascade is
the product. Both feed **one** invalidation fan-out over the affected cells:

1. **Base string changed** *(primary)* — `TranslationKey.sourceRevision` bumps; cells where
   `sourceRef != sourceRevision` go `stale` and re-enter the router.
2. **Context changed** *(secondary)* — `Project.contextRevision` bumps on any scoped context write;
   cells resolving through a changed scope may re-flag. Collapse to one trigger if the re-flagging
   proves noisy.

The third trigger an earlier draft carried — **judge changed** — is gone with `Calibration`. One
path; one-or-two sources wired into it.

### Branching mechanics

- **Read (resolution):** a cell `(branch, key, locale)` is the branch's own row if present, else
  it falls through `parent → … → main`. Key visibility follows the same rule — a branch-introduced
  key is visible on that branch and its descendants only, until merged.
- **Merge:** a `TranslationRun{trigger=merge}` that applies a child branch's touched cells/keys
  onto its parent. Conflict detection is **free**: a cell whose parent `head` advanced past the
  `forkPoint`-recorded one has moved on both sides → conflict, surfaced like any other escalation
  (human, or a re-loop with both values as context). Every branch mutation — generated *or* merged
  — goes through the same run primitive under the same `head` guard; merge is not a separate path.
- **Selection at the edge:** a Release pins one branch (above). The store only manages branches;
  the deploy pipeline chooses which one ships. So A/B, feature flags, and OTA gating add **no**
  per-key state — they're branch choices resolved at export.

### Concurrency

No separate optimistic-lock integer. Concurrency falls out of structure the model already has:

- **In-flight exclusivity:** a run claims the cell (`lockedByRunId`) while working, so two runs
  don't fight over the same draft.
- **Accept guard:** finalizing an accept is a **compare-and-swap on `head`** — write only if the
  cell's head is still the one this run read; a loser re-enters the loop with the winner's value as
  new context. No lost updates across multiple developers/teams on a cell.
- **Merge baseline:** the same `head` is the merge conflict token (vs the `forkPoint`-recorded one).
- **Run idempotency:** `TranslationRun.idempotencyKey` dedupes at-least-once webhook delivery; runs
  are resumable and cancelable.

### Lifecycle / state

Translation lifecycle is an explicit transition table including the return edges
`escalated → proposed|accepted` and a `retired → proposed` resurrection edge. Structural
entities use soft-delete `lifecycle`; context entities use `proposed|active|retired|archived`.

### Retention

Two append-only histories share the table — `TranslationVersion` and `Release`. Each is bounded by
its natural grain (one version per accept, one Release per export), so no cell grows an unbounded hot
partition. With the `ReviewSignal` ledger cut, the old signal-compaction rule is gone — there is no
per-cell signal stream left to compact.

### Recurring patterns

Two shapes recur across the model; naming them removes special-casing and reveals the spine.

- **Judgment → context → fan-out.** When an *external* judgment lands — an Escalation resolved, a
  FieldReport filed — the same two things happen: optional **context** is spawned (an Example or
  GlossaryTerm), and the affected cells **re-enter the router** (reopen + re-stale). One verb, two
  triggers. (No signal ledger in the middle — the cut removed it.)
- **Append-only history.** `TranslationVersion` and `Release` share one *shape*: immutable, monotonic
  `seq`/`version`, `supersededBy`, never rewritten. They stay distinct entities (different grain and
  queries), but they're the immutable half of the governing principle applied twice.

## Physical layout — single DynamoDB table

The whole model lands on the existing `table + GSI1/2/3` topology with **no new GSI**. Today's
layout (`repository/keys.ts`): translations are partitioned by locale
(`PROJ#<pid>#LOC#<code>`, SK `KEY#<ns>#<name>`), and GSI3 flips that to read one key across
locales. Branching threads in as **one extra segment** in those same keys.

```
Branch (config)     PK = PROJECT#<pid>      SK = BRANCH#<branchId>   (parent, forkPoint, status)
Translation cell    PK = PROJ#<pid>#BR#<branchId>#LOC#<code>   SK = KEY#<ns>#<name>
GSI3 (key→locales)  GSI3PK = PROJ#<pid>#BR#<branchId>#KEY#<ns>#<name>   GSI3SK = LOC#<code>
History             same cell partition, SK-prefixed:
                      SK = KEY#<ns>#<name>            ← live cell (mutable; lifecycle state lives here)
                      SK = KEY#<ns>#<name>#VER#<seq>  ← TranslationVersion (append-only)
Comment (branch-free) PK = PROJ#<pid>#CMT#LOC#<code>   SK = KEY#<ns>#<name>#<seq>   ← shared across branches
Release (immutable)  PK = PROJ#<pid>#REL#<releaseId>   SK = META | KEY#<ns>#<name>#<code>
```

- **`main` is not special** — it's `branchId = "main"` baked into the PK. No migration thinking.
- **Copy-on-write read** = at most *depth* point-reads up the parent chain (branch trees are
  shallow); a missing branch row falls through to the parent partition. No scan, no join.
- **Merge / export** = query the branch's locale partitions, overlay onto the parent's. Conflict
  detection compares the cell's own `head` vs the `forkPoint` baseline — no new data.
- **Branch-introduced keys** are the one wrinkle: a key born on a branch must stay out of `main`'s
  key list until merge. The key-definition row keeps its `KEY#<ns>#<name>` SK but carries
  `introducedOnBranchId`; `main`'s listing filters out unmerged-origin keys, and merge clears the
  flag. A read-time filter, not a structural change.

| Access pattern | How | New GSI? |
|---|---|---|
| Read a cell on a branch | `GET PROJ#pid#BR#br#LOC#code / KEY#ns#name` | no |
| COW fall-through | ≤ depth point-reads up the parent chain | no |
| Key across locales on a branch | GSI3 + `BR#` segment | reuses GSI3 |
| All cells on a branch (merge/export) | query the branch's locale partitions | no |
| Cell history (versions) | query cell partition by SK prefix | no |
| Comments on a (key, locale) | query `PROJ#pid#CMT#LOC#code` `begins_with KEY#ns#name` | no |
| List branches | query project partition `begins_with BRANCH#` | no |
| What shipped | query the Release partition | no |

**Net cost of the whole redesign in storage terms:** one new entity (`Branch`) + one segment
(`#BR#<id>`) inside PK/SK strings that already exist. The 3-GSI deploy topology is untouched.

## Outside this model's boundary

Concepts that are real but belong to a *different* model — a capability, an RBAC tier, an external
pipeline — rather than this data model. Noted so the boundary is explicit:

- **Branch-scoped context (and comments)** — per-branch `ContextRule` overrides, or a comment pinned
  to one branch's value. In this model both context and comments are **shared across branches**
  (industry keeps glossary global); `Scope` and the comment target each have a clean place to add a
  `branchId` if either ever needs the branch axis.
- **Presentation as a stored UI model / scope axis** — a nested interface tree
  (`surface ⊃ screen ⊃ region ⊃ component`) maintained inside Turjuman, or a presentation tier added
  to `Scope`. **Cut.** A second containment chain breaks `override`: `namespace:checkout` and
  `screen:payment` are *incomparable* (neither contains the other), so "narrowest wins" has no
  defined winner and the precedence ladder loses its total order. (Locale survives as a second axis
  only because it is a point-selector, not a chain.) Where a string sits in the UI is therefore
  **briefing data, never an override target** — captured as the flat `Key.placements` hint and
  rendered into the agent briefing (see *Situational awareness*), not modeled as structure. The
  agent-facing briefing *format* (the `surface/screen/role` vocabulary and its serialization) is a
  rendering spec to pin down when the projection is built, not data-model state.
- **Measured-trust subsystem** — a folded `Trust` score over an append-only `ReviewSignal` ledger,
  signal-independence ranking, a versioned `Calibration` (judge-of-the-judge), `ReviewRound` /
  `roundsToConverge`, and the stakes-buy-depth **economics layer**. **Cut** after four independent
  reviews (customer job-to-be-done, "the LLM already does it", YAGNI, market reality) converged. Why:
  (1) the judge is an *external* model the app doesn't own, so a persisted `0..1` is a frozen opinion,
  invalid the moment base/context drift — an agent in the loop re-derives faithfulness/tone for free
  against the *current* value; (2) `Calibration`'s premise (a human hand-builds and version-maintains
  gold exemplars per scope) reintroduces the very labor the product removes, so it ships empty and
  makes every score it backs meaningless; (3) independence ranking assumes multiple frontier vendors
  per string, but self-hosters run one model family; (4) no shipping TMS
  (Crowdin/Lokalise/Phrase/Locize/Weblate/Tolgee) models the heavy version — they converge on *status
  + QA checks + comments + approve + a single AI-confidence-score-with-threshold*, and we go one notch
  **leaner than even that**: the residue kept here is a **3-state cell lifecycle**
  (`proposed → accepted | escalated`), the accept/re-loop/escalate router, slim `Escalation`, slim
  `FieldReport`, `Comment`, and verifiable-constraints-in-generation — **no score, no threshold.** The
  agent's confidence sets the lifecycle at write time; the app stores the outcome, not the number. Add
  a score only the day a human genuinely can't tell the iffy strings from the good ones without one,
  and rebuild the ledger only when there is a second, *independent* signal to rank — not one paragraph
  sooner.
- **Agent-driven auto-merge** — a *capability*, not model state: merge conflicts are surfaced as
  escalations (or re-loops); how they get resolved is the service layer's concern.
- **NamespaceMembership** — an optional third RBAC tier for shared-namespace ownership across
  teams.
- **Reporter** as a full entity, per-plural-category review state and constraints, and Example
  retrieval ranking beyond the deterministic default.
- **Hard rule:** any retrieval or ranking reaching for embeddings breaches *no in-app model*.
  Retrieval stays deterministic (scope-proximity + quality + recency).

## Open questions

- Does the accept-CAS conflict + staleness fan-out interact to cause a re-loop storm on a hot cell
  (every writer invalidating every other)? Needs a back-pressure rule on the run loop.
- Granularity of `contextRevision`: one project counter is simple but over-invalidates; a
  per-scope revision is precise but heavier. (A modeling choice — which most truthfully represents
  "this context changed" — not a sequencing one.)
- A/B branches may never merge (they live as parallel deploys) while feature branches always do —
  so is `status: merged` terminal, or do long-lived experiment branches need a distinct
  `status: live`? Affects whether a Release can pin a branch that's neither `open` nor `merged`.
- Merge against a moved base: if `main`'s `sourceRevision` advanced under a branch cell, is that a
  staleness event, a merge conflict, or both? (Likely both — same machinery, different surfacing.)
