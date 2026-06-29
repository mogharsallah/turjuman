# Turjuman data model — diagrams

Visual companion to `data-model-redesign.md`. Each diagram answers one question. They're
Mermaid, so they render on GitHub and in any Mermaid viewer.

---

## 1. The whole map (entity-relationship)

Who points at whom. Attributes trimmed to the identifying few — see the design doc for full
fields.

```mermaid
erDiagram
    ORG          ||--o{ PROJECT        : contains
    USER         ||--o{ APIKEY         : owns
    USER         ||--o{ MEMBERSHIP     : has
    PROJECT      ||--o{ MEMBERSHIP     : grants

    PROJECT      ||--o{ NAMESPACE      : "has (optional)"
    PROJECT      ||--o{ LOCALE         : has
    PROJECT      ||--o{ TRANSLATIONKEY : has
    NAMESPACE    ||--o{ TRANSLATIONKEY : "groups (optional)"

    PROJECT      ||--o{ BRANCH         : "main + parallel lines"
    BRANCH       ||--o{ BRANCH         : "forks from (parent)"
    BRANCH       ||--o{ TRANSLATION    : "owns (copy-on-write)"
    RELEASE      }o--|| BRANCH         : "pins one"

    TRANSLATIONKEY ||--o{ TRANSLATION  : "× locale × branch"
    TRANSLATION  ||--o{ TRANSLATIONVERSION : "commit chain (append-only)"
    TRANSLATION  ||--|| TRUST           : "carries (derived fold)"
    TRUST        ||--o{ REVIEWSIGNAL    : "ledger (append-only)"
    TRANSLATION  ||--o{ ESCALATION      : "may open"

    CALIBRATION  ||--o{ REVIEWSIGNAL    : "scored under"

    PROJECT      ||--o{ RELEASE         : "shipped snapshots"
    RELEASE      ||--o{ TRANSLATIONVERSION : "pins (immutable)"
    PROJECT      ||--o{ TRANSLATIONRUN   : "agent jobs"
    TRANSLATIONRUN ||--o{ TRANSLATION   : "writes cells"

    PROJECT      ||--o{ FIELDREPORT     : receives
    FIELDREPORT  }o--|| TRANSLATION     : "negative evidence"

    SCOPE        ||--o{ CONTEXTRULE     : locates
    SCOPE        ||--o{ GLOSSARYTERM    : locates
    SCOPE        ||--o{ EXAMPLE         : locates
```

> `SCOPE { projectId, namespace?, keyId?, locale? }` is a value object, not a row — every
> context entity embeds one, which is how a single ContextRule / GlossaryTerm / Example can live
> at any cell of the grid. (Voice, length, stakes, compliance, and the review-policy knobs are all
> `ContextRule` kinds; Trust and ReviewRound are derived, so they aren't drawn as base entities.)

---

## 2. The root principle, made visible

The model splits into **living/mutable** (one current value, changes in place) and
**immutable/historical** (append-only, never rewritten). This split is the whole point.

```mermaid
flowchart LR
    subgraph LIVING["🟢 LIVING — mutable, one current value"]
        T["Translation<br/>value · head ptr (= accept + merge guard)"]
        TR["Trust<br/>derived fold of the ledger (cached)"]
        CTX["Context cells<br/>ContextRule · Glossary · Example"]
    end

    subgraph HISTORY["🔵 IMMUTABLE — append-only history"]
        TV["TranslationVersion<br/>every accepted value"]
        SIG["ReviewSignal ledger<br/>every piece of evidence"]
        REL["Release<br/>every shipped snapshot"]
        CAL["Calibration<br/>every judge version"]
    end

    T -- "accept writes" --> TV
    T -- "head ptr points into" --> TV
    TR -- "folds" --> SIG
    REL -- "pins" --> TV
    SIG -- "scored under" --> CAL

    classDef live fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef hist fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    class T,TR,CTX live
    class TV,SIG,REL,CAL hist
```

> "Approved" is **not** a mutable slot you overwrite — it's a pointer into immutable history.
> "Live" is **not** a per-cell flag — it's the latest Release. Trust **is** the fold of its
> ledger, so recalibrating is a re-fold, never a destructive rewrite.

---

## 3. The context cascade (how one string's context is resolved)

Context is a grid: scope tiers nested vertically, locale orthogonal across them. Resolution
walks the 6-cell ladder per merge-operator.

```mermaid
flowchart TD
    subgraph GRID["The grid for one (key, locale)"]
        direction TB
        PA["project × all"] --> PL["project × locale"]
        PL --> NA["namespace × all"]
        NA --> NL["namespace × locale"]
        NL --> KA["key × all"]
        KA --> KL["key × locale ⭐ narrowest"]
    end

    KL --> R{{"resolve per operator"}}
    R --> O["override → narrowest wins<br/>(voice, stakes, length)"]
    R --> U["union → collect all 6<br/>(glossary, examples)"]
    R --> RS["restrict → AND all 6<br/>(compliance, safety)"]

    O --> B["📦 resolved bundle"]
    U --> B
    RS --> B
    B --> TF["locale-shaping post-step<br/>(plural · RTL · expansion)<br/>NOT a cascade operator"]
    TF --> PROV["📦 bundle + provenance"]
    PROV --> AGENT["→ handed to the MCP agent as translation context"]

    classDef narrow fill:#fef3c7,stroke:#d97706,color:#78350f
    class KL narrow
```

> Narrowest-wins is only the **override** rule; glossary *unions*, compliance *restricts* — the
> operator is a property of the context **type**, not the tier. Three folds, then a separate
> locale-shaping post-step (plural/RTL/expansion is *not* a cascade operator). A cross-tier
> override is logged in provenance and *raises review depth*.

---

## 4. One translation's lifecycle (the review router)

Review is a **router with three exits**, not a one-way approval gate. Cheap re-translation
means most "failures" loop back in with the objection as new context.

```mermaid
stateDiagram-v2
    [*] --> untranslated
    untranslated --> proposed : agent generates<br/>(constraints enforced inside)

    proposed --> proposed : re-loop<br/>(objection = new context)
    proposed --> accepted : trust ≥ threshold
    proposed --> escalated : deadlock /<br/>restrict-conflict /<br/>budget exhausted

    escalated --> accepted : human: accept-value
    escalated --> proposed : human: new-value/new-rule
    note right of escalated
        on resolve, writes a
        ReviewSignal(human-decision,
        ground-truth) → reusable context
    end note

    accepted --> proposed : stale<br/>(base/context/judge changed)
    accepted --> retired : key deprecated
    retired --> proposed : resurrection

    accepted --> [*] : ships in a Release
```

> The human is the **terminal** exit, used only for irreducible judgment — and even then the
> decision becomes a ground-truth signal that feeds future loops. Verifiable rules
> (placeholders, ICU, length) never reach this machine; they're enforced *during* generation.

---

## 5. One loop iteration (where trust comes from)

How a single cell goes from "agent produced a string" to "we trust it enough to ship",
and where each independence-ranked signal enters.

```mermaid
flowchart TD
    START["TranslationRun picks up a cell<br/>(captures sourceRef)"] --> GEN["Agent generates value"]
    GEN --> HARD{"Verifiable constraints<br/>placeholders · ICU · length · glossary"}
    HARD -- fail --> GEN
    HARD -- pass --> JUDGE["Judgmental review<br/>(calibrated judge)"]

    JUDGE --> SIGS["Collect ReviewSignals → Trust ledger"]
    SIGS --> S1["render / real-user · ground-truth"]
    SIGS --> S2["round-trip · deterministic"]
    SIGS --> S3["cross-family consensus · cross-model"]
    SIGS --> S4["same-model consensus · weak"]

    S1 --> FOLD["Trust = fold(signals)"]
    S2 --> FOLD
    S3 --> FOLD
    S4 --> FOLD

    FOLD --> ROUTE{"Router"}
    ROUTE -- "trust ≥ threshold" --> ACC["accept → write TranslationVersion"]
    ROUTE -- "below, rounds left" --> GEN
    ROUTE -- "deadlock / budget out" --> ESC["escalate → human"]

    ACC --> SHIP["eligible for next Release"]

    classDef gt fill:#dcfce7,stroke:#16a34a
    classDef weak fill:#fee2e2,stroke:#dc2626
    class S1 gt
    class S4 weak
```

> Signals are ranked by **independence**: a real UI render outranks a deterministic check,
> which outranks cross-family model disagreement, which outranks same-model consensus
> (≈ measures stability, not correctness). Depth (how many signals you bother to collect) is
> set by the string's **stakes**.

---

## 6. Staleness — one fan-out, three triggers

Three different changes can invalidate a translation; they all feed **one** invalidation
path. Build it once.

```mermaid
flowchart LR
    T1["Base string edited<br/>Key.sourceRevision ↑"] --> FAN
    T2["Context edited<br/>Project.contextRevision ↑"] --> FAN
    T3["Judge changed<br/>new Calibration version"] --> FAN

    FAN{{"staleness fan-out<br/>over affected cells"}} --> MARK["Translation.stale = true<br/>Trust invalid until re-eval"]
    MARK --> RUN["enqueue TranslationRun<br/>(re-translate / re-judge)"]
    RUN --> Rit["back into the loop (diagram 5)"]

    classDef trig fill:#fef3c7,stroke:#d97706
    class T1,T2,T3 trig
```

> Each trigger is detected by comparing a stored stamp on the Translation against the current
> one: `sourceRef` vs `Key.sourceRevision`, `contextRevisionAtEval` vs
> `Project.contextRevision`, `calibrationRef` vs the active Calibration.

---

## 7. Concurrency (why nothing gets lost when teams collide)

```mermaid
sequenceDiagram
    participant A as Agent A (team 1)
    participant T as Translation cell (head = v7)
    participant B as Agent B (team 2)

    A->>T: read (head = v7)
    B->>T: read (head = v7)
    A->>T: accept if head==v7 ✅ → head = v8
    B->>T: accept if head==v7 ❌ conflict
    T-->>B: conflict + current value (v8)
    B->>B: re-loop with A's value as new context
    B->>T: accept if head==v8 ✅ → head = v9
```

> Accept is a **compare-and-swap on `head`** (the cell's pointer to its latest commit) — no
> separate lock integer. The loser doesn't fail, it **re-enters the loop** informed by the
> winner's value. A run also holds `lockedByRunId` so two runs don't fight over the same draft.

---

## 8. Branching — one concept for variants, experiments & feature flags

`main` is the safe root. A branch is a **copy-on-write** overlay: it stores only the cells it
touches and falls through to its parent for everything else. Selection of what ships happens at
the **Release/export edge**, not on the key.

```mermaid
flowchart LR
    subgraph MAIN["main branch (safe root — always shippable)"]
        M1["pay_button = 'Pay'"]
        M2["cart_title = 'Cart'"]
        M3["greeting = 'Hi'"]
    end

    subgraph FEAT["feature/checkout-v2 (copy-on-write)"]
        F1["pay_button = 'Complete order'  (override)"]
        FNEW["express_pay = 'Express'  (new key, hidden from main)"]
        F2["·· cart_title → falls through to main ··"]
    end

    M1 -. fork .-> FEAT
    M2 -. fall-through .-> F2
    FEAT == "merge = TranslationRun trigger:merge; head vs forkPoint detects conflicts" ==> MAIN

    RELA["Release A → pins main"] --> MAIN
    RELB["Release B → pins feature/checkout-v2"] --> FEAT

    classDef main fill:#dbeafe,stroke:#2563eb
    classDef feat fill:#dcfce7,stroke:#16a34a
    class M1,M2,M3 main
    class F1,FNEW feat
```

> **A/B testing** = two long-lived branches (`exp-a`, `exp-b`), each with its own value; deploy
> both Releases and let the pipeline route traffic. **Feature flag / unreleased** = a branch that
> isn't pinned by any production Release yet. **Safe experiment** = branch, try, then merge or
> abandon — `main` never moved. One mechanism; the old `TranslationVariant` and `FeatureBundle`
> ideas are gone.

## How to read these together

- **Diagram 1** is the static map; **2** is the one idea everything rests on.
- **3** is what happens *before* a translation (assemble context); **4–5** are the
  translation/review loop itself; **6–7** are the forces that push cells *back* into that loop.
- Everything funnels to one place: a cell becomes an immutable **TranslationVersion**, which a
  **Release** pins — and that, not any mutable flag, is what "shipped" means.
