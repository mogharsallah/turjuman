# Contributing to Turjuman

Thanks for contributing. This guide covers how to set up the repo, run the tests, and where changes
go. It's about working **on** Turjuman (the GitHub repo) — the product documentation lives separately
in `docs/` (the published Mintlify site).

Related docs:

- **`CLAUDE.md`** — the architecture, the dev loop, and the authoritative "where to make changes" map.
- **`TESTING.md`** — how to *write* tests that pin behaviour (read before adding or changing tests).
- **`ROADMAP.md`** — what's built and what's next (and what's deliberately out of scope).

## Setup

Requires Node ≥ 24 and pnpm.

```bash
pnpm install      # also installs git hooks (pre-commit + hooksPath) via the prepare script
pnpm run build    # builds every workspace in dependency order (core first)
pnpm run typecheck
```

Note: dependents import `@turjuman/core`'s built `dist`, so after editing `core` run `pnpm run build`
(or at least build `core`) before other packages' typecheck/tests see the change.

## Local development

Everything runs against a shared LocalStack (there is no localhost server). See the **Commands**
section of `CLAUDE.md` for the full dev-loop details; the short version:

```bash
pnpm run localstack:up        # shared LocalStack on :4566
cp .env.example .env          # AWS_ENDPOINT_URL=http://localhost:4566, dummy creds
pnpm run dev                  # deploy into LocalStack + hot reload; prints URLs + an API key
```

Each working copy (clone or git worktree) deploys its own isolated dev stack, so parallel sessions can
share one LocalStack. `pnpm run dev:teardown` removes just this working copy's stack.

## Tests

Three tiers. The default `pnpm test` is hermetic; the LocalStack tiers need Docker and self-skip when
their endpoint env vars are unset.

```bash
pnpm test                                                                        # unit (hermetic)
pnpm run localstack:up && pnpm run test:integration && pnpm run localstack:down  # repo+services vs real DynamoDB
pnpm run test:e2e                                                                # deploy SAM stack + black-box HTTP e2e
```

Every PR runs build + typecheck + unit, the docs link check, and the integration + deployed-e2e tiers
in GitHub Actions — treat those checks as the source of truth for end-to-end verification. (Any
Mintlify preview/build check is non-blocking.)

For the conventions every new or changed test must follow, read **`TESTING.md`**.

## Formatting & linting

[Biome](https://biomejs.dev) owns formatting + linting (`biome.json`). You rarely run it by hand — a
`pre-commit` hook auto-formats staged files and CI runs `biome ci .`.

```bash
pnpm run check         # format + lint, report only
pnpm run check:write   # apply formatting + safe lint fixes
```

The generated `docs/api-reference/openapi.json` snapshot is owned by `pnpm run gen:openapi` and
excluded from Biome — never reformat it by hand.

## Where to make changes

`CLAUDE.md` → **"Where to make changes"** is the authoritative map. In short: business logic and
authorization live in `@turjuman/core`; every capability is declared once as an operation in
`@turjuman/sdk` and projected to the MCP and REST surfaces — never hand-write a transport-specific tool
or route that bypasses `OPERATIONS`.

## Documentation

Product docs are the published Mintlify site in `docs/` and must change in the **same PR** as the code.
Use the `writing-docs` skill (`.claude/skills/writing-docs/`) when adding or revising a page — it's the
source of truth for the docs craft, the code→docs map, and the docs structure. REST endpoint pages are
auto-generated from the OpenAPI snapshot; never hand-write them.

## Pull requests

- Keep changes focused; update docs and tests in the same PR as the code.
- Make sure the GitHub Actions checks pass before requesting review.
- Scope is intentionally bounded — no web UI, no built-in machine-translation engine, no vendor
  marketplace (see `ROADMAP.md`).
