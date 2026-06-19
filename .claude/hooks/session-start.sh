#!/bin/bash
# SessionStart hook for Claude Code on the web.
# Installs workspace dependencies so the hermetic dev loop works out of the box:
#   - npm run test / test:unit   (vitest, hermetic)
#   - npm run typecheck          (strict tsc — this repo's "linter")
set -euo pipefail

# Only run in the remote (Claude Code on the web) environment. Local machines
# manage their own setup.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# `npm install` (not `npm ci`) reuses the cached node_modules layer on resume,
# so it's fast and never wipes the already-installed packages. It can, however,
# rewrite package-lock.json — so restore the lockfile afterward to keep it
# frozen and avoid leaving a dirty git tree at the start of every session.
npm install
git checkout -- package-lock.json 2>/dev/null || true
