#!/bin/sh
# Runs every harness in chapter 16 and prints the last line of each log.
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

run basic_code_example/example/files basic_code_example/example/output/run_basic.log "npx tsx run_basic.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_forge.log "npx tsx run_forge.ts"
run solutions_and_explanations/exercise_1_nightly-magazine-build-with-autonomous-unmapped-asset-recovery/files solutions_and_explanations/exercise_1_nightly-magazine-build-with-autonomous-unmapped-asset-recovery/output/run_ex1.log "npx tsx run_ex1.ts"
run solutions_and_explanations/exercise_2_baseline-grid-vertical-rhythm-across-twelve-spreads/files solutions_and_explanations/exercise_2_baseline-grid-vertical-rhythm-across-twelve-spreads/output/run_ex2.log "npx tsx run_ex2.ts"
run solutions_and_explanations/exercise_3_knuth-plass-typographic-qa-with-a-vision-model-feedback-loop/files solutions_and_explanations/exercise_3_knuth-plass-typographic-qa-with-a-vision-model-feedback-loop/output/run_ex3.log "npx tsx run_ex3.ts"
run solutions_and_explanations/exercise_4_print-and-digital-dual-export-with-a-preflight-gate/files solutions_and_explanations/exercise_4_print-and-digital-dual-export-with-a-preflight-gate/output/run_ex4.log "npx tsx run_ex4.ts"
run solutions_and_explanations/exercise_5_template-rebind-style-map-and-thread-rewiring-from-a-legacy-idml/files solutions_and_explanations/exercise_5_template-rebind-style-map-and-thread-rewiring-from-a-legacy-idml/output/run_ex5.log "npx tsx run_ex5.ts"

exit "$FAILED"
