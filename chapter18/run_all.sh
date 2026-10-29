#!/bin/sh
# Runs every harness in chapter 18 and prints the last line of each log.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

PY=$("$ROOT/../tools/pick_python.sh")
FAILED=0

run() {
  dir="$ROOT/$1"; log="$ROOT/$2"; cmd="$3"
  mkdir -p "$(dirname "$log")"
  if [ ! -d "$dir" ]; then
    printf '%-18s %s\n' "$(basename "$log" .log)" "skipped (no project)"
    return 0
  fi
  if ( cd "$dir" && eval "$cmd" ) > "$log" 2>&1; then
    printf '%-18s %s\n' "$(basename "$log" .log)" "$(tail -1 "$log")"
  else
    printf '%-18s %s\n' "$(basename "$log" .log)" "FAILED — see $log"
    FAILED=1
  fi
}

run basic_code_example/example/files \
    basic_code_example/example/output/run_basic.log \
    "npx tsx run_basic.ts"

run advanced_application_implementation/example/files \
    advanced_application_implementation/example/output/run_forge.log \
    "npx tsx run_forge.ts"

run solutions_and_explanations/exercise_1_multi-entity-consolidation-with-named-ranges-and-cross-sheet-references/files \
    solutions_and_explanations/exercise_1_multi-entity-consolidation-with-named-ranges-and-cross-sheet-references/output/run_ex1.log \
    "$PY run_ex1.py"

run solutions_and_explanations/exercise_2_scenario-toggle-architecture-with-cascading-assumption-cells/files \
    solutions_and_explanations/exercise_2_scenario-toggle-architecture-with-cascading-assumption-cells/output/run_ex2.log \
    "$PY run_ex2.py"

run solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/files \
    solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/run_ex3.log \
    "$PY run_ex3.py"

run solutions_and_explanations/exercise_4_cross-team-reconciliation-with-cell-level-lineage-and-audit-trail/files \
    solutions_and_explanations/exercise_4_cross-team-reconciliation-with-cell-level-lineage-and-audit-trail/output/run_ex4.log \
    "$PY run_ex4.py"

run solutions_and_explanations/exercise_5_board-ready-financial-deck-binding-with-multimodal-consistency-review/files \
    solutions_and_explanations/exercise_5_board-ready-financial-deck-binding-with-multimodal-consistency-review/output/run_ex5.log \
    "$PY run_ex5.py"

exit "$FAILED"
