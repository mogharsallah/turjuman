#!/usr/bin/env bash
# WorktreeRemove hook: when Claude Code removes a session's worktree (i.e. you
# archive / `/exit` a non-primary Remote Control session), stop the dev services
# that session left running. Fire-and-forget: this cannot block removal, so it
# only cleans up — it never fails the removal.
#
# Two per-session actions, both strictly scoped to the worktree being removed:
#   1. Kill dev processes (scripts/dev.mjs + its esbuild/Lambda children) whose
#      working directory is inside this worktree.
#   2. Tear down ONLY this copy's LocalStack stack via `dev:teardown`, which reads
#      the worktree's .turjuman-dev marker and leaves the shared LocalStack and
#      every other session's stack untouched (never `localstack:down`).
#
# The primary session lives in the main checkout (no worktree), so it has nothing
# to remove and this hook never fires for it.
set -uo pipefail

# WorktreeRemove delivers the target path as JSON on stdin: {"worktree_path": …}.
payload="$(cat)"
wt="$(printf '%s' "$payload" | jq -r '.worktree_path // empty' 2>/dev/null)"
[ -n "$wt" ] || exit 0

# 1. Kill any process whose cwd is inside the worktree (Linux /proc walk). This
#    catches the dev loop and its children regardless of how they were spawned.
for cwd in /proc/[0-9]*/cwd; do
  tgt="$(readlink "$cwd" 2>/dev/null || true)"
  case "$tgt" in
    "$wt"|"$wt"/*)
      pid="$(basename "$(dirname "$cwd")")"
      kill "$pid" 2>/dev/null || true
      ;;
  esac
done

# 2. Tear down this copy's dev stack — only if it ever deployed one (marker present)
#    and the dir still exists at hook time. dev:teardown self-no-ops otherwise.
if [ -f "$wt/.turjuman-dev" ]; then
  ( cd "$wt" && timeout 120 corepack pnpm run dev:teardown ) >/dev/null 2>&1 || true
fi

exit 0
