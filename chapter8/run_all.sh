#!/bin/sh
# Runs every harness in chapter 8 and prints the last line of each log.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

PY=$("$ROOT/../tools/pick_python.sh")
FAILED=0

run() {
  dir="$ROOT/$1"; log="$ROOT/$2"; cmd="$3"
  mkdir -p "$(dirname "$log")"
  if ( cd "$dir" && eval "$cmd" ) > "$log" 2>&1; then
    printf '%-18s %s\n' "$(basename "$log" .log)" "$(tail -1 "$log")"
  else
    printf '%-18s %s\n' "$(basename "$log" .log)" "FAILED — see $log"
    FAILED=1
  fi
}

run basic_code_example/example/files basic_code_example/example/output/run_basic.log "npx tsx run_basic.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_forge.log "npx tsx run_forge.ts"
run solutions_and_explanations/exercise_1_the-b-zier-glyph-foundry-parametric-icon-system-with-explicit-anchor-math/files solutions_and_explanations/exercise_1_the-b-zier-glyph-foundry-parametric-icon-system-with-explicit-anchor-math/output/run_ex1.log "npx tsx run_ex1.ts"
run solutions_and_explanations/exercise_2_live-blend-morphing-engine-for-animated-brand-marks/files solutions_and_explanations/exercise_2_live-blend-morphing-engine-for-animated-brand-marks/output/run_ex2.log "$PY run_ex2.py"
run solutions_and_explanations/exercise_3_non-destructive-pathfinder-composition-for-multi-resolution-logos/files solutions_and_explanations/exercise_3_non-destructive-pathfinder-composition-for-multi-resolution-logos/output/run_ex3.log "npx tsx run_ex3.ts"
run solutions_and_explanations/exercise_4_autonomous-multimodal-b-zier-refinement-loop-vision-guided-path-smoothing/files solutions_and_explanations/exercise_4_autonomous-multimodal-b-zier-refinement-loop-vision-guided-path-smoothing/output/run_ex4.log "$PY run_ex4.py"
run solutions_and_explanations/exercise_5_vector-store-driven-parametric-icon-synthesis-knn-governed-style-transfer-betwee/files solutions_and_explanations/exercise_5_vector-store-driven-parametric-icon-synthesis-knn-governed-style-transfer-betwee/output/run_ex5.log "$PY run_ex5.py"

exit "$FAILED"
