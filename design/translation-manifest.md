# Turjuman — the TranslationManifest

> Internal design note, not published docs. It extends the model in
> `data-model-redesign.md` with **situational awareness**: how the translating agent learns
> *where* a string lives in the application interface, and how that context reaches the
> consumers that can't see the code. This is the model as designed; implementation
> sequencing is out of scope.

## The goal, and the trap

The translating agent is fluent and context-starved. Knowing a string is `pay_button` in
the `checkout` namespace is weaker than knowing it is the **primary action of the payment
screen, next to "Cancel", under a 16-character width budget, on mobile**. That situational
awareness is the goal.

The trap is to model it by **rebuilding the application's UI inside Turjuman** — a stored,
nested interface tree that the agent maintains as a second source of truth. That tree drifts
the moment code changes, has no automatic staleness trigger (the base string can be
byte-identical while its placement is a lie), and re-introduces a second containment
hierarchy that breaks context resolution (below). So the design keeps the *goal* and refuses
the *mechanism*.

## The invariant that shapes everything

> **`Scope` stays `{projectId, namespace?, keyId?, locale?}`. A presentation coordinate
> (surface/screen/region) never appears in a scope and never carries authoring power.**

Why this is a proof, not a preference: context resolves by **narrowest-wins** along a single
containment chain (`project ⊃ namespace ⊃ key`), with locale as an orthogonal *point-selector*
(one tie-break bit). `override` — the operator behind voice, stakes, length, and every
review knob — requires a **total order** to pick a winner.

Adding presentation as a *second containment chain* produces **incomparable** pairs:
`namespace:checkout` and `screen:payment` — neither contains the other. For a key in both,
"narrowest wins" has no defined winner; any precedence you invent ("screen beats namespace")
is arbitrary, and the clean 6-cell ladder becomes a partial order with no canonical
flattening.

```
  locale survived as a 2nd axis because it is a POINT-SELECTOR (one bit), not a chain.
  presentation IS a chain → it does NOT get the same free pass.
```

(`restrict` and `union` would survive — AND/union are order-independent — but `override`
is the dominant operator, so the break is real.) Therefore: **where a string sits in the UI
is never a thing you hang an override on.** It is briefing data only.

## Three moves that keep the model small

**① The manifest re-organizes existing truth — it introduces almost none.** What a
human-on-the-screen actually carried — register, length pressure, term choice — is *already*
first-class as `voice` / `length` / `stakes` / `Example` / `GlossaryTerm`. The manifest's
job is to **present** the already-resolved cascade in one legible briefing, optionally
organized by where strings sit. The serialization arranges facts the cascade resolved; it is
not a new store.

**② One thin new stored fact — a placement hint — justified solely by repo-less consumers.**
The live agent (Claude Code) has the repo, so for *it* placement is a live read and a stored
copy is strictly staler. But this model is full of consumers that **don't** have the code:
merge runs (`valueSource=branch`), field-report re-translations, cheap reviewer/consensus
models handed only Turjuman's context, CI export. For them, "where does this live" is
otherwise lost. So placement is **externalized context for the carriers who can't see the
code** — exactly the governing law, not a UI cache.

**③ The high-value leaf flags mostly already exist.** `maxLength` *is* a `length`
ContextRule; ICU-ness is known (plurals stored canonically); only a key-level `noTranslate`
(brand names, codes, identifiers) is a genuinely missing effect. The manifest *surfaces*
these — it does not store new copies.

## The placement hint

A flat **list** on the Key — never a tree, never a scope:

```
  Key.placements: [{ surface, screen, role, order? }]

    surface   web | mobile | desktop | cli | voice | email | print | ...   (the medium — a
              FIELD, never a path prefix; a key reused on web + mobile has two entries)
    screen    a flat handle for the perceived/uttered unit the user is in at once
              (a screen, a page, an email body, a CLI command's output, a dialogue turn)
    role      closed enum (below)
    order?    integer reading/utterance order within the screen — stored, because order is
              NOT recoverable from a set
```

Flat `surface + screen + role`, **not** a deep `screen/region/component` path. That single
choice dodges the two real failures of a derived tree at once: no prefix collisions (a node
that is both a key and a parent), and order is an explicit field rather than a brittle
ordinal smuggled into a path segment. "Neighbors on the payment screen" = *other keys with
the same `surface` + `screen`* — the one thing genuinely not already in the model (siblings
cross namespaces), recovered by projection, never stored as edges.

**Root word is `surface`/`screen`, not "screen-the-web-widget".** A voice app's screen is a
dialogue turn; a CLI's is a command's output block; an email's is its body. We model the
semantic unit every medium shares — the "HTML of i18n context" — never a per-framework
widget taxonomy.

**Roles (closed enum + a freeform `note`):** `title, body, action, cta, label, placeholder,
hint, error, warning, status, caption, a11y-label, disclaimer`. Closed, so the agent can
switch on it reliably; the escape hatch is a separate `note` string, not an open-ended role.
`cta` is split from `action` (imperative punch vs neutral), `warning` from `error` (severity),
`disclaimer` added (legal register, often must-not-soften). `tooltip` is dropped (== `hint`).

**Key-level flag (the one missing effect):** `Key.noTranslate?: boolean` — brand names,
codes, identifiers that must survive verbatim. (Glossary `doNotTranslate` is term-level; this
is the whole-key case.)

### Honesty rules (bias to under-claim)

A *missing* placement is safe; a *wrong* placement misleads with confidence. So:

- **Missing = safe.** No placement → the agent falls back to the normal cascade briefing
  (namespace voice, length, examples, glossary). Absence must read as *absent*, never as
  "placement says nothing special."
- **Stale = demoted to hint, never a constraint.** A placement carries `uiSourceRef` + a
  `stale` flag. A stale placement is shown as a weak hint and is **never** fed to the
  inside-generation constraint machinery (a stale `surface: voice` or `maxLength` could
  actively misdirect). Better no map than a confidently wrong one.
- **Deleted keys don't dangle.** Placements ride the existing `Scope` + `orphanedContext[]`
  path, so a placement for an archived/renamed key surfaces as an orphan warning, not a
  dangling pointer.

### Capture

Capture is **agent-authored**, the only mechanism compatible with the constraints (no
per-framework extractor, no in-app intelligence, no running app). The coding agent reads the
UI source and emits placements via an MCP operation (`manifest.attach(keyRef, placement)`
incrementally, or a bulk `manifest.put`). Turjuman stores the facts and renders the briefing;
it never infers UI from code itself.

Be honest about cost: re-sync is an **O(UI) re-read**, not a cheap incremental recompute —
the agent re-reads the UI surface and re-emits. There is no `ui.changed` tripwire Turjuman
can fire on its own, so re-sync is agent-initiated. This is the weakest freshness profile of
any context type; the honesty rules above are what make it safe anyway.

Its one genuine edge over screenshot/OCR tooling (Crowdin/Lokalise/Localazy): **key-linking
is exact**, emitted as `keyRef → placement`, never OCR-guessed. Its concession: it captures
the *code-derived* signal, never rendered pixels — so it must never pose as visual ground
truth (overflow, RTL mirroring, runtime states). It is a *structured situational map*, not a
screenshot.

## The manifest is a projection

The `TranslationManifest` is **rendered on demand**, never stored — assembled from
`placements` + the *resolved* cascade, at a configurable radius. Token-lean serialization
(indentation for nesting, role-leading, one line per node — ~2–3× cheaper than nested XML),
with the resolved ContextRules surfaced inline:

```
surface mobile · screen checkout.payment · target fr
  label   checkout.payment.card_label      "Card number"
  error   checkout.payment.error_declined  "Your card was declined"
  cta     checkout.payment.pay_button      "Pay now"   max=16 stakes=critical
  ↳ neighbors on this screen: card_label, error_declined  (translate the action set in
    parallel register)
```

`max=16 stakes=critical` are *resolved ContextRules surfaced inline* — not authored in the
manifest. `"Pay now"` is the base value; `target fr` says what to produce. One screen block
is a complete translation briefing for a repo-less consumer.

**Configurable depth falls out for free** because it is a projection, not a store — render
the same placements at a chosen radius:

```
  L0  key + role only                          (cheapest)
  L1  + its screen + sibling roles
  L2  + full neighbor text on the screen       (adjacency — what else the user sees)
  L3  + adjacent screens in the flow           (derived from order across screens)
```

## What this is, and is not

```
  KEEP   manifest = a projection/serialization (re-organizes resolved context; no new truth)
         + Key.placements: [{surface, screen, role, order?}] — briefing data, never a scope,
           biased to under-claim, justified solely by repo-less consumers
         + Key.noTranslate? — the one genuinely missing effect

  CUT    a stored UI tree · presentation-as-a-scope-axis · region/component depth ·
         flow edges · shared-chrome subsystem · "cheaply regenerated" framing · XML-as-store ·
         any pretense of pixel/render truth

  INVARIANT   Scope never gains a presentation coordinate. Where a string sits in the UI is
              briefing data, never an override target.
```

The grand "interface model inside Turjuman" collapses to *a projection + a thin per-key
placement hint*. It keeps situational awareness exactly where it pays — the carriers without
the repo — and refuses to rebuild the application's UI as a second source of truth.

## Resolved / open

- **Resolved — placement granularity:** flat `surface + screen` handle, not a deep path.
  Sub-screen regions are a finer cut to add only if a real distinction demands it; the domain
  truth is "a key is on a screen in a role."
- **Open — is `order` worth storing, or do we accept set-unordered placements** and let the
  agent infer reading order from the base UI when it has the repo? Order matters most for the
  repo-less consumer (the only one that can't infer it), which argues for keeping it.
- **Open — `noTranslate` as a Key flag vs a `noTranslate` ContextRule kind.** Modeled here as
  a key flag (it's a property of the string's identity, not a scoped policy), but it could
  fold into ContextRule if per-locale exceptions ever appear.
