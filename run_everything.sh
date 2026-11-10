#!/bin/sh
# Runs the deterministic suite, then the live model paths.
#
#   run_offline.sh   the 154 harnesses: real engines, scripted model, no key
#   run_live.sh      the nine entry points that call a model
#   run_everything.sh  this file: both, in that order
#
# The live half needs OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL
# (see run_live.sh --list). Without them it is skipped, not failed, so this
# script is safe to run on a machine that only wants the deterministic half.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)

"$ROOT/run_offline.sh"
offline=$?

if [ -z "${OPENAI_COMPATIBLE_API_KEY:-}" ] || [ -z "${OPENAI_COMPATIBLE_BASE_URL:-}" ]; then
  printf '\nlive paths skipped: OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL are not set\n'
  exit "$offline"
fi

printf '\n'
"$ROOT/run_live.sh"
live=$?

if [ "$offline" -eq 0 ] && [ "$live" -eq 0 ]; then
  exit 0
fi
exit 1
