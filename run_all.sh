#!/bin/sh
# Runs every harness in the book and prints one line per harness.
#
# Each chapter carries its own `run_all.sh`; this script calls them in
# order and keeps going after a failing chapter, so one run reports the
# state of the whole book.
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
