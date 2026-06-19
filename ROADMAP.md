# Turjuman Roadmap

This is the single source of truth for **what's built and what's next**. Phases are ordered by
priority; within a phase, items are roughly sequential. Check items off as they land.

Post-v1 direction (Phase 5 onward) is prioritized by *buyer impact ÷ implementation effort* — market
positioning and the ranked buyer-decision drivers behind each item. Each item carries a distilled
*why* inline so it stands on its own.

Status legend: ✅ done · 🚧 in progress · ⬜ not started

---

## Shipped — Phases 0–4 + the QA layer

### Phase 0 — Foundation ✅

- ✅ Monorepo (npm workspaces) + TypeScript tooling
- ✅ `core`: domain model, single-table DynamoDB repository (GSI1/2/3), transactional email uniqueness
- ✅ First-class RBAC: global roles (OWNER/ADMIN/MEMBER) + project roles (MANAGER/EDITOR/DEVELOPER/VIEWER)
- ✅ Service layer with all business logic + authorization
- ✅ API-key authentication (hashed bearer tokens)
- ✅ Published, composable AWS CDK construct (`@turjuman/aws-cdk`): DynamoDB (on-demand/provisioned, optional PITR + deletion protection) + Lambda Function URLs, with api/webhook toggles and per-function tuning
- ✅ One-command `turjuman-aws-deploy deploy` (`@turjuman/aws-deploy`): deploys the construct from pre-bundled npm Lambda assets via the CDK programmatic toolkit, self-bootstrapping the standard CDK environment (no SAM CLI), with client-side first-owner bootstrap and the canonical config in SSM

### Phase 1 — MCP server (the heart) ✅

- ✅ Stateless MCP over Streamable HTTP, deployed as a Lambda handler
- ✅ **40 tools**: projects, locales, keys, translations (incl. bulk fill + review + stale), glossary,
  translation memory, QA checks, webhooks, and users/members/API keys
- ✅ Agent-driven translation flow (`list_untranslated` → translate → `bulk_set_translations`)
- ✅ `tools/list` scoped per API key (read-only → read tools; org-gated tools hidden from a `MEMBER`)
  and per connection URL (`?tools=` / `?groups=`) — narrows the advertised surface; RBAC still gates calls
- ✅ Verified end-to-end against DynamoDB Local + LocalStack (lifecycle, RBAC, tenant isolation, live HTTP)

### Phase 2 — REST API + developer CLI ✅

- ✅ REST API reusing the service layer (list/export, bulk import keys + translations)
- ✅ `turjuman` CLI: `login`, `init`, `pull`, `push`, `build`
- ✅ Formats: nested JSON (i18next), flat JSON, YAML
- ✅ GitHub Actions example for CI sync
- ✅ Verified against a **deployed** stack on LocalStack (CDK toolkit deploy, in CI); a **live AWS
  account** deploy is still unverified (see [Known gaps](#known-gaps--follow-ups))

### Phase 3 — Breadth ✅

Shipped in three work-streams (3.1 formats · 3.2 glossary+TM · 3.3 workflow/infra).

**3.1 — Formats, plurals & multi-target CLI ✅**
- ✅ Format adapters: Flutter ARB, Java `.properties`, CSV, Android `strings.xml`, iOS `.strings`, iOS `.stringsdict`
- ✅ ICU plural handling end-to-end (canonical ICU ⇄ native category forms, plural-aware (de)serialization)
- ✅ Per-entry descriptions carried through formats that support them (ARB/CSV/`.properties`/iOS `.strings`)
- ✅ Multi-target / multi-namespace CLI config (one project → many format+path+namespace targets)
- ⬜ gettext PO and XLIFF (1.2/2.0) adapters — **promoted to Phase 5** (industry interchange formats)

**3.2 — Glossary + Translation Memory ✅**
- ✅ Glossary (term base) with do-not-translate + per-locale preferred terms; surfaced to the LLM via `list_glossary`
- ✅ Translation memory (`lookup_translation_memory`): exact, normalized and bigram-fuzzy matches, derived from existing translations

**3.3 — Workflow / infra ✅**
- ✅ Webhooks / events: DynamoDB Streams → dispatcher Lambda, HMAC-signed POSTs (`add_webhook`/`list_webhooks`/`remove_webhook`)
- ✅ Project deletion with cascade cleanup (`delete_project`, confirm-gated)
- ✅ API-key revocation (`revoke_api_key`) — self-service + admin

### Phase 4 — Lifecycle foundations (the substrate) ✅

The element state machine that turns the CRUD surface into a continuous-localization loop, and the
substrate the governed-AI quality layer (Phase 5) builds on. Full design — stages and the
key/translation state model — in [docs/concepts/lifecycle.mdx](docs/concepts/lifecycle.mdx).

- ✅ **Dual-slot translations** — a working `value` plus an `approvedValue` snapshot; the `approved`
  status transition promotes `value → approvedValue`. `pull` / `exportBundle` ship `approvedValue` by
  default (with `--working` / source-fallback / `--exclude-stale` options), so unreviewed and
  edited-since-approval work can't leak into delivered output.
- ✅ **Source-change staleness** — each translation stamps the base value it was written against
  (`sourceRef`); dependents auto-flag `stale` when the source changes, non-destructively
  (`approvedValue` keeps shipping). Exposed via `list_stale` (MCP), a list filter, and a
  `translation.stale` event.
- ✅ **Key deprecation lifecycle** — keys carry an `active` / `deprecated` state with `lastSeenAt`,
  namespace-scoped, restore-on-reappear; replaces hard-delete-on-`--prune`.
- ✅ **Translation provenance** — `origin` (human/llm/tm/mt/import) on each value, set in every write
  path and surfaced to the reviewer; the input the Phase-5 governed review routes on.

---

## Next — the strategic bet

> **Thesis:** in translation management the monetized value has moved *off* the machine-translation
> (MT) **engine** — now a commodity everyone has — and *onto* the **governance / quality layer**:
> automated QA, MQM-based quality scoring, and AI review / auto-LQA, typically gated behind higher paid
> tiers. AI is now a *baseline* expectation, so the differentiator is no longer raw MT but **governed
> AI** — automatically deciding what's good enough to ship vs. what needs a human. Turjuman's play: **give
> that layer away for free**, delivered through the MCP/agent model and the BYO-LLM that already does
> the translating. The combination that makes Turjuman strong on the axes that convert:
> **free QA checks + free MQM AI scoring/review + BYO-LLM translation + self-host.**

The phases below are ordered by leverage — *buyer impact ÷ implementation effort* — so the cheapest,
highest-credibility wins come first. Each item is written to stand on its own: **what it is** (jargon
decoded), **why it matters** (the buyer-decision value), and a short **build** note on where it slots
into the existing code.

### Phase 5 — Governed-AI quality layer (the wedge) 🚧

The highest impact-per-effort work and the heart of the strategic bet; each item maps cleanly onto
existing `core` plumbing. Suggested order (by impact÷effort):
**QA checks → AI scoring/review → PO/XLIFF.**

#### ✅ Automated QA checks — *shipped*

Deterministic linting for translations: ICU-syntax, placeholder/variable, plural-form, tag/markup
integrity, length, whitespace/punctuation, glossary consistency, empty/duplicate, plus lifecycle-aware
stale/coverage detection.

- *What it is.* A "spell-check for translations" — automated rules that catch the mechanical errors a
  translator or LLM can introduce: a broken `{count}` placeholder, a missing plural form, mismatched
  HTML tags, a string that's too long for its button, an inconsistent glossary term.
- *Why it matters.* Table-stakes that every serious translation tool ships; this was the
  single biggest credibility gap Turjuman had. Buyer-decision weight: *high — a table-stakes feature
  Turjuman used to lack.*
- *Build.* A pure check engine in `core/qa/` (reuses the ICU parser in `packages/core/src/formats`)
  with per-project config (enable/disable, severity, ignore rules); exposed as MCP tools
  (`run_qa_checks` / `get_qa_config` / `set_qa_config`), a REST route, and a CLI/CI gate
  (`turjuman check` / `push --check`). Advisory only — it flags, it never auto-approves. See
  [docs/reference/qa-checks.mdx](docs/reference/qa-checks.mdx).

#### ⬜ AI quality scoring + AI review (MQM 0–100) — *the signature feature*

- *What it is.* After the LLM translates a string, it's asked to **grade its own output** and return a
  single **0–100** quality score; the system then **auto-routes** on that score — a high score
  auto-promotes the translation to `approved` (shipping it through the Phase-4 dual-slot model), a low
  score flags it for a human reviewer. The score is computed against **MQM** (*Multidimensional Quality
  Metrics*) — the industry-standard scorecard that grades a translation by structured error category
  (accuracy/mistranslation, fluency/grammar, terminology, style, locale conventions) instead of a vague
  pass/fail. Reviewing against such a rubric is what the industry calls **LQA** (*Language Quality
  Assurance*).
- *Why it matters.* This is the **single most-monetized AI capability** in the market — commercial tools
  sell it under various brand names behind a paid tier, and they standardize on MQM. With AI now a
  baseline expectation, *governed* AI (decide-what-ships, not just translate) is the axis actively
  converting buyers. Buyer-decision weight: *high and rising.* Giving it away free, on top of the free
  QA checks, is what makes Turjuman strong where it counts.
- *Why it fits Turjuman.* Because the translator is already **your own connected LLM** (BYO-LLM, no
  bundled engine), asking it to also score is nearly free — there's no separate quality model to
  license, unlike tools that charge for scoring as an add-on. Mechanically it's small: a `score` field
  on the translation, one new status transition, and two MCP tools (`score_translation` /
  `review_translations`), routing on the `origin` provenance signal Phase 4 already records. The
  tagline: **governed AI, for free** — the AI does the work *and* a first-pass review, while the human
  role-gate stays in control.

#### ⬜ gettext PO + XLIFF (1.2/2.0) adapters

- *What it is.* Two file formats for moving translations between tools. **gettext PO** (`.po` files) is
  the decades-old standard of the **open-source world** (GNU gettext — Linux, GNOME, WordPress, countless
  OSS projects). **XLIFF** (*XML Localization Interchange File Format*, versions 1.2 and 2.0) is the
  **professional industry's** exchange format: when a company hands work to a translation agency or
  **LSP** (*Language Service Provider*), they almost always swap **XLIFF** files. It's the lingua franca
  between TMS tools and the human-translation supply chain.
- *Why it matters.* These two formats unlock two whole populations Turjuman can't serve today — the
  OSS ecosystem (PO) and anyone who works with translation vendors (XLIFF). Without XLIFF you can't
  interoperate with the professional supply chain at all. Buyer-decision weight: *medium (industry
  interchange)* — not a headline, but a portability checkbox most translation tools already tick.
- *Build.* Slots straight into the existing `packages/core/src/formats/` adapter architecture — the same
  pattern behind the 9 shipped formats with ICU-plural canonicalization. Low effort. *(Promoted from the
  Phase 3 deferred list.)*

### Phase 6 — Reach (broaden inputs & integrations) ⬜

Get *more context in* and *more places to sync*. None of these is the strategic wedge, but each removes
a concrete adoption blocker.

#### ⬜ Key context: screenshots + usage notes

- *What it is.* Attach an **image** (a screenshot of where a string appears in the running app) and
  freeform **usage notes** to each key, alongside the description/tags it already carries.
- *Why it matters.* Translation quality lives or dies on context. "Post" is a noun (a blog post) or a
  verb (to post) depending entirely on where it sits — a screenshot of the actual button resolves the
  ambiguity instantly, for a human reviewer *and* for the LLM. It's the **#2 most-praised quality
  feature** in buyer reviews (right behind developer integrations) and the foundation the in-context
  editor (Phase 7) builds on. Buyer-decision weight: *medium-high.*
- *Build.* New key fields + image storage + MCP tools to set/read them; the context then feeds the
  translate and review tools. Medium effort. *(Promoted from Phase 3.)*

#### 🚧 Richer key filtering / search

- *What it is.* First-class query patterns over keys: filter by **status** (e.g. "everything still
  awaiting review"), **tag**, and **namespace**, plus full-text search across names/descriptions.
  Namespace/tag filters, cursor pagination, and the `list_stale` "what changed" query already shipped
  with Phase 4; **status filtering** and **full-text search** are what remain.
- *Why it matters.* Past a few thousand strings, "show me exactly what needs my attention right now"
  becomes the core daily workflow — the difference between usable-at-scale and not. Quality-of-life, but
  it compounds.
- *Build.* Extends the existing `list_keys` / `search_keys` service methods and their GSI access
  patterns. Low–medium effort. *(Promoted from Phase 3.)*

#### ⬜ GitLab + Bitbucket sync + richer PR-back CI

- *What it is.* Turjuman already syncs with **GitHub** via the CLI in CI. This extends that to the two
  other major code hosts — **GitLab** and **Bitbucket** — and enriches **"PR-back" automation**:
  Turjuman opens a pull request with updated translations automatically, so finished work flows back
  into the codebase as a reviewable change instead of a manual `pull`.
- *Why it matters.* Developer integrations + CI/CD automation is the **#1 ranked buyer-decision driver**
  — the most common reason engineering-led teams adopt or switch a TMS, because it kills manual file
  upload/download. Turjuman already does the hard part (the deterministic CLI sync); this just widens
  the door to teams not on GitHub. Buyer-decision weight: *medium-high.*

### Phase 7 — Differentiators & enterprise (longer-term) ⬜

Bigger bets and enterprise-governance gates. Higher effort, narrower or later payoff.

#### ⬜ OTA / live translation delivery + lightweight SDKs (web + mobile)

**OTA** = *over-the-air*: instead of translations being baked into the app at build time, the app
**fetches them live** from a cached endpoint — so you can fix a French typo without shipping a new
app-store release. The **SDKs** are small web + mobile libraries that do that fetching. This is the
flagship feature for mobile-first teams. The serverless
stack can already expose a cached delivery endpoint cheaply; the SDKs are the real work. High effort,
high payoff for a specific segment.

#### ⬜ In-context / visual editing (SDK overlay)

An overlay on your **running app** where you click any piece of on-screen text and edit its translation
in place, seeing it in real context. It's the most-praised quality feature in the market and pairs
naturally with the key screenshots from Phase 6. Delivered as an **SDK
overlay, not a hosted web app** — consistent with the no-web-UI decision below. High effort.

#### ⬜ Audit log / activity history

A queryable record of **who changed what, when**. The system already emits these events internally via
DynamoDB Streams, so capturing them into a history is cheap — and it's broadly useful for debugging and
is an enterprise-governance gate. Buyer-decision weight: *medium-high (enterprise gate).*

#### ⬜ Cognito / OAuth 2.1 + SSO/SAML

Enterprise login plumbing. **SSO** (*single sign-on*) lets employees authenticate with their corporate
identity; **SAML** is the protocol behind it; **OAuth 2.1** is the modern authorization standard the MCP
spec mandates (auth spec `2025-11-25`). A hard gate for large enterprises — but heavier to build, and it
matters less for a self-hosted deployment you already control. Buyer-decision weight: *high (enterprise
gate).*

#### 🚧 Rate limiting / API-key scopes & expiry

Production API hardening. Shipped: **read-only API keys** (a key limited to `*.read` actions
regardless of the user's role) and **key expiry** (`expiresAt`, after which a key stops
authenticating). Still open: **rate limiting** to cap requests per client — non-trivial because the
Lambda Function URLs front no API Gateway, so it needs DynamoDB-backed counters or reserved
concurrency — and finer-grained **named scopes** beyond the read-only boolean, if a use case demands.

### Explicitly out of scope

Deliberate non-goals — keep the product **pure MCP-first / developer-first**:

- **Web UI / web editor.** Turjuman's interface *is* the agent; we will not build a dashboard or web
  editing surface. *(Considered and declined: the trade-off is ease-of-use / non-technical reach, but
  the MCP-first bet is the whole point of the product. In-context editing, if built, ships as an SDK
  overlay — not a hosted app.)*
- **MT engine integrations (DeepL / Google / AWS Translate).** The connected LLM *is* the translator
  (BYO-LLM); we will not bundle or proxy a separate machine-translation engine. *(Considered as a
  portability/credibility add and declined: a parallel MT path would dilute the LLM-first model and add
  provider plumbing for little gain. MT engines are commoditized table-stakes — Turjuman's bet is the
  governed-AI layer on top, not the engine.)*
- **Professional-translation ordering / vendor marketplace** — a services business, not a fit for a free
  self-hosted tool.
- **Translation-proxy / GDN-style website delivery** — heavy infra, far from the dev-first thesis.

---

## Known gaps & follow-ups

- **Live-cloud deploy still unverified.** A deployed end-to-end path now runs on **LocalStack**
  (`npm run test:e2e` — the CDK stack, Lambda Function URLs, and the real DynamoDB Streams → webhook
  flow, in CI), but the stack has not yet been deployed via the CDK toolkit against a **live
  AWS account**.
- **Pagination.** `list_keys`, `search_keys`, `list_untranslated`, `list_stale`,
  `get_translations(locale)`, the REST `GET /translations`, and the `GET /bundle` export all support
  cursor pagination (`limit`/`cursor`) — the MCP growth tools default to a 100-key page (max 200) and
  return a `nextCursor`, paging the key partition and resolving each page key with a point read. The
  CLI still pulls whole bundles (unchanged); wire it to stream pages if a project grows large enough to
  need it. The inherently-small lists (`list_members`, `list_locales`, `list_glossary`, `list_users`)
  read in full by design.
- **Webhook delivery is at-most-once.** The dispatcher checks HTTP status and times out a hanging
  endpoint, but does not retry or dead-letter a failed delivery (it logs and moves on). Add an SQS DLQ
  + replay if guaranteed delivery becomes a requirement.
- **Async job pattern (Phase 5 prerequisite).** The API is synchronous request/response with no
  job/status primitive. The long-running governed-AI **scoring/review** work in Phase 5 is the natural
  driver for one; designing it is deliberately deferred until that work begins.
- ✅ **Free-tier knobs.** On-demand vs. provisioned (25 RCU/WCU split across the table + 3 GSIs) billing
  is now a deploy-time knob (`--set table.billingMode=PROVISIONED`), alongside PITR and deletion
  protection.

Contributions welcome — pick an unchecked item and open a PR.
</content>
</invoke>
