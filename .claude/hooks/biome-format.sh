#!/usr/bin/env bash
# PostToolUse hook: auto-format the file Claude just edited with Biome
# (formatting + safe lint fixes), so the agent never re-reads or spends tokens
# fixing style/lint noise it introduced. Runs on Edit/Write/MultiEdit only.
#
# Non-blocking by contract: always exits 0 and swallows Biome's output, so a
# formatting hiccup or a not-yet-installed Biome can never stall an edit. The
# real CI gate is `biome ci` (see .github/workflows/ci.yml); this is just a
# convenience that keeps the working tree clean as it's written.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-$PWD}"

bin="${CLAUDE_PROJECT_DIR:-$PWD}/node_modules/.bin/biome"
[ -x "$bin" ] || exit 0

# The edited path arrives as tool_input.file_path in the hook's stdin JSON.
file="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.file_path||"")}catch{}})')"
[ -n "$file" ] || exit 0

# --files-ignore-unknown skips files Biome doesn't handle (e.g. .md/.mdx) as a
# silent no-op; --no-errors-on-unmatched avoids failing when the path is ignored.
"$bin" check --write --no-errors-on-unmatched --files-ignore-unknown=true "$file" >/dev/null 2>&1 || true
exit 0
