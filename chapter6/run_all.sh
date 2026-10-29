#!/bin/sh
# Runs every harness in chapter 6 and prints the last line of each log.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

FAILED=0
PY=$("$ROOT/../tools/pick_python.sh")
: "${PY:?Python 3.10+ is required for exercise 3}"

# The repository's own environment (tools/install_python_deps.sh) carries
# the `jsonschema` and `Pillow` this exercise needs. A dedicated virtual
# environment can still be forced with CAP6_VENV.
VENV=${CAP6_VENV:-}
if [ -n "$VENV" ]; then
  if [ ! -x "$VENV/bin/python" ]; then
    "$PY" -m venv "$VENV"
  fi
  "$VENV/bin/pip" install --quiet \
    -r "$ROOT/solutions_and_explanations/exercise_3_autonomous-agentic-correction-loop-screenshot-critique-re-clip-repeat/files/requirements.txt"
  VENV_BIN="$VENV/bin/python"
else
  VENV_BIN="$PY"
fi

run() {
  dir="$ROOT/$1"; log="$ROOT/$2"
  mkdir -p "$(dirname "$log")"
  if ( cd "$dir" && eval "$3" ) > "$log" 2>&1; then
    printf '%-18s %s\n' "$(basename "$log" .log)" "$(tail -1 "$log")"
  else
    printf '%-18s %s\n' "$(basename "$log" .log)" "FAILED — see $log"
    FAILED=1
  fi
}

run basic_code_example/example/files basic_code_example/example/output/run_basic.log "npx tsx run_basic.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_forge.log "npx tsx run_forge.ts"

# Worked solutions. Each harness keeps its own evidence under the solution's
# output/ directory; the log written here sits beside those artefacts.
run solutions_and_explanations/exercise_1_e-commerce-banner-assembly-with-clipping-mask-discipline-and-contract-layer-nami/files solutions_and_explanations/exercise_1_e-commerce-banner-assembly-with-clipping-mask-discipline-and-contract-layer-nami/output/run_banner.log "npx tsx run_banner.ts"
run solutions_and_explanations/exercise_2_oklch-inspired-curve-grading-with-runtime-schema-validation-and-cross-machine-re/files solutions_and_explanations/exercise_2_oklch-inspired-curve-grading-with-runtime-schema-validation-and-cross-machine-re/output/run_ex2.log "npx tsx run_ex2.ts"
run solutions_and_explanations/exercise_3_autonomous-agentic-correction-loop-screenshot-critique-re-clip-repeat/files solutions_and_explanations/exercise_3_autonomous-agentic-correction-loop-screenshot-critique-re-clip-repeat/output/run_ex3.log "$VENV_BIN run_ex3.py"
run solutions_and_explanations/exercise_4_batch-layer-contract-audit-across-a-legacy-psd-archive/files solutions_and_explanations/exercise_4_batch-layer-contract-audit-across-a-legacy-psd-archive/output/run_ex4.log "npx tsx run_ex4.ts"
run solutions_and_explanations/exercise_5_hierarchical-agentic-workflow-supervisor-executor-pattern-for-non-destructive-cl/files solutions_and_explanations/exercise_5_hierarchical-agentic-workflow-supervisor-executor-pattern-for-non-destructive-cl/output/run_ex5.log "npx tsx run_ex5.ts"

# Exercise starters.

exit "$FAILED"
