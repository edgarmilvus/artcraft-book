#!/bin/sh
# Runs every harness in the book and prints one line per harness.
#
# The deterministic half: the real engines, a scripted model, no key. Each
# chapter carries its own runner; this script calls them in order and keeps
# going after a failing chapter, so one run reports the state of the book.
#
#   run_offline.sh      this file
#   run_live.sh         the paths that call a real model
#   run_everything.sh   both
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/tools/craft-cli/bin:$ROOT/tools/node/bin:$PATH"

failed=0
for chapter in $(seq 1 20); do
  script="$ROOT/chapter${chapter}/run_all.sh"
  if [ ! -x "$script" ]; then
    printf '%-18s %s\n' "chapter${chapter}" "skipped (no runner)"
    continue
  fi
  printf '\n=== chapter %s ===\n' "$chapter"
  if ! "$script"; then
    printf '%-18s %s\n' "chapter${chapter}" "FAILED"
    failed=1
  fi
done

exit "$failed"
