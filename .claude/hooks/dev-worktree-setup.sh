#!/usr/bin/env bash
# SessionStart hook: bootstrap a fresh git worktree so `pnpm run dev` works out of
# the box. A new worktree is a clean checkout — node_modules, .env, and the built
# dist/ are NOT carried over from the main checkout — so install deps, seed .env,
# and build once. Each step is guarded, so warm worktrees return in milliseconds.
#
# Runs ONLY inside a linked git worktree. The main checkout and every ordinary
# session hit the guard below and exit immediately (no-op), so this never
# re-imposes setup work on a normal clone.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}"

# A linked worktree's git-dir lives under <repo>/.git/worktrees/<id>; the main
# checkout's is just ".git". Only bootstrap in the former.
case "$(git rev-parse --git-dir 2>/dev/null || true)" in
  *"/worktrees/"*) ;;
  *) exit 0 ;;
esac

# Use the pnpm version pinned in package.json's packageManager field via Corepack,
# so this works without a globally-installed pnpm.
[ -d node_modules ] || corepack pnpm install --frozen-lockfile
[ -f .env ] || cp .env.example .env
# Dependents import core's built dist, so a worktree needs a build before the dev
# loop / typecheck see it. Sentinel on core's entry keeps this a one-time cost.
[ -f packages/core/dist/index.js ] || corepack pnpm run build
