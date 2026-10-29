#!/usr/bin/env bash
# Everything the CI workflow checks, on this machine.
#
#   tools/check.sh              # all five steps
#   tools/check.sh --fast       # skip the install step, assume node_modules
#
# The point of running it here is that CI's value is a *clean* tree: no
# leftover node_modules, no installed engines, no outputs from an earlier run.
# This script is the same five commands, so a green local run and a green CI
# run mean the same thing.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 1

fail=0
step=0
total=5

head() {
  step=$((step + 1))
  printf '\n\033[1m== %d/%d  %s\033[0m\n' "$step" "$total" "$1"
}

run() {
  if "$@"; then
    return 0
  fi
  printf '   FAILED: %s\n' "$*"
  fail=1
}

head "dependencies"
if [ "${1:-}" = "--fast" ] || [ -x node_modules/.bin/tsc ]; then
  echo "   node_modules present"
else
  run npm ci --no-audit --no-fund
fi

head "the shared dependency tree is linked into every project"
run node tools/link_node_modules.mjs --check

head "every TypeScript listing compiles"
run node tools/typecheck_all.mjs

head "the master MCP server compiles"
run ./node_modules/.bin/tsc -p tsconfig.master.json

head "every project README matches the files it names"
run python3 tools/check_project_readmes.py

if [ "$fail" -eq 0 ]; then
  printf '\n\033[1mOK\033[0m  five checks, no failures\n'
else
  printf '\n\033[1mFAILED\033[0m  see the lines above\n'
fi
exit "$fail"
