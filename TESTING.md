# TESTING.md

Testing conventions for Turjuman. Concise by design — these rules are meant to be read by both
humans and coding agents before writing or changing tests. New test code must conform.

For *how to run* the suites (commands, the LocalStack tiers, CI), see `CLAUDE.md` and
`docs/contributing.mdx`. This file is about *how to write tests that actually pin behavior*.

## Core principle

Turjuman is "one source-of-truth registry, many thin projections" (`OPERATIONS`, `ADAPTERS`,
`CHECKS`, the RBAC maps). Tests **mirror that** — loop the registries instead of hand-writing N
near-identical cases.

**The one rule that makes this safe:** a test that derives its expectation from the artifact
under test asserts `X === X` and is green forever. **Every registry-driven test must have a
second, independent oracle** — hand-authored expected values, distinct sentinels, or golden
files that do *not* come from the code being tested. Loop for *structure*; assert *behavior*
against independent data.

## Writing assertions

- **Distinct per-field sentinels.** Give each input field a unique value (`projectId:"P_proj"`,
  `name:"N_name"`, `namespace:"NS_ns"`) and assert each argument slot carries *its* sentinel. A
  matcher that can't catch a `name`↔`namespace` swap proves nothing.
- **Hand-author expectations.** Expected `(method, args)`, RBAC truth tables, and golden
  envelopes are written by hand, independently of the implementation.
- **Name every looped case.** Use `describe.each(REGISTRY)("$name", …)`, one invariant per
  block, so a failure names the member *and* the invariant — never "case 7".
- **Test error paths.** Cover the masking boundary (AppError surfaced; non-AppError masked +
  logged), validation rejections, and every branch/throw a loop skips. Happy-path-only is
  incomplete.
- **Assert exact call counts.** `toHaveBeenCalledTimes(1)` + exact args + "no other method
  fired" beats a loose `toHaveBeenCalled()`.

## Test layers — classify by what a test *stands up*, not by aspiration

| Layer | Scope | Speed / gating |
|---|---|---|
| **L0 hermetic — contract** | Handler arg-mapping, registry structure; in-memory fakes only | Fast, always runs |
| **L1 hermetic — pure logic** | RBAC matrix, adapter round-trips, QA checks, plurals; property tests live here | Fast, always runs |
| **L3 integration** | Real DynamoDB single-table invariants + REST-projection wiring | Slow; `describe.skipIf(!env)` |
| **L5 e2e** | Deployed black-box over Function URLs, classic *and* code mode | Slowest; `describe.skipIf(!env)`; keep tiny |

Anything that boots a transport stack or a real datastore is integration/e2e — not L0/L1. Don't
label a slow test "unit" because you wish it were one.

## Fakes & isolation

- Shared fakes are **factories** (`makeFakeRepo()`), never shared instances; build fresh per
  `it`. Vitest runs files in parallel — shared mutable state is a flake.
- The **data-layer** fake `FakeRepo implements RepositoryApi` — **no `as unknown as Repository`
  cast**. The compiler must enforce method completeness, or the fake silently drifts from the real
  repo. (One narrow exception: a *transport* test that only needs the repo to authenticate may use a
  minimal three-method auth stub with a cast — `FakeRepo` lives under a build-excluded
  `src/testing/**` and so isn't importable across the published-`dist` boundary. Confine that cast to
  one shared `*.test-support.ts` helper, not a copy per spec.)
- **No test code in published `dist`.** Shared test support lives in a path the package build
  excludes (`tsconfig.build.json` excluding `src/testing/**`, or a `*.test-support.ts` suffix).
  Verify with `pnpm pack`.

## Property tests (fast-check)

- Round-trip in the **correct direction**: `parse(serialize(entries)) ≈ entries` over the
  canonical model — generate `TranslationEntry[]`, never arbitrary strings.
- `≈` is an explicit, per-adapter **field-survival spec** (e.g. iOS drops plurals, Android
  description is write-only) declared as data, compared by **one central, self-tested
  comparator**. **Inline per-test normalization is banned** — it's how `≈` quietly erodes to
  nothing.
- Scope generators so they never emit inputs a format legitimately cannot represent.
- Confine fast-check to `formats`, `schema`, `sandbox` (adapter round-trips, marshal escapes,
  plurals). No guest-code fuzzing.

## Determinism

- Fixed clock (`vi.setSystemTime(...)`) in any suite touching `Date`/cursors.
- fast-check: **pin and print** the seed so failures reproduce.
- Goldens contain **zero** nondeterministic fields (ids, timestamps) — normalize before compare.

## Coverage & change discipline

- Gate on **registry completeness**, not line %. A missing fixture/corpus/table entry fails the
  loop. A meta-test asserts each fixture parses against `op.input`, populates every field, and
  uses distinct sentinels — so "registry-complete" means "actually asserted," not "present".
- **Additive-then-subtractive.** A new suite lands green *alongside* the old; an old file is
  removed only with a checklist mapping each old `it()` to its new home. Coverage never dips.
- **Non-rewritable — keep bespoke, do not fold into a loop:** sandbox byte-truncation /
  use-after-free / multibyte-split cases; pagination page-count assertions; dual-slot delivery
  sequence; CONFLICT/NOT_FOUND nuances (last-owner, expired key, duplicate email); every
  branch/throw path a contract loop skips.

## Scope limits

- Mutation testing (Stryker): optional, nightly only, scoped to pure logic (`sdk` handlers,
  `rbac.ts`, `plural.ts`). **Never `sandbox`** (per-run WASM module = hours). Sentinels are the
  primary non-vacuity backstop, not mutation testing.
- No stateful op-sequence property tests — targeted integration tests pin those invariants.
