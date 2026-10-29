#!/bin/sh
# Runs every harness in chapter 7 and prints the last line of each log.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

PY=$("$ROOT/../tools/pick_python.sh")

run() {
  dir="$ROOT/$1"; log="$ROOT/$2"
  mkdir -p "$(dirname "$log")"
  ( cd "$dir" && eval "$3" ) > "$log" 2>&1
  printf '%-18s %s\n' "$(basename "$log" .log)" "$(tail -1 "$log")"
}

run basic_code_example/example/files basic_code_example/example/output/run_basic.log "npx tsx run_basic.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_aperture.log "npx tsx run_aperture.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_python_loop.log "$PY run_python_loop.py"
run solutions_and_explanations/exercise_1_autonomous-e-commerce-hero-banner-correction-loop-with-vision-guided-curve-refin/files solutions_and_explanations/exercise_1_autonomous-e-commerce-hero-banner-correction-loop-with-vision-guided-curve-refin/output/run_ex1.log "npx tsx run_ex1.ts"
run solutions_and_explanations/exercise_2_brand-compliance-vision-auditor-for-vectorcraft-packaging-die-lines/files solutions_and_explanations/exercise_2_brand-compliance-vision-auditor-for-vectorcraft-packaging-die-lines/output/run_ex2.log "npx tsx run_ex2.ts"
run solutions_and_explanations/exercise_3_designcraft-editorial-spread-multimodal-widow-orphan-detection-and-rewrap-prophe/files solutions_and_explanations/exercise_3_designcraft-editorial-spread-multimodal-widow-orphan-detection-and-rewrap-prophe/output/run_ex3.log "npx tsx run_ex3.ts"
run solutions_and_explanations/exercise_4_lightcraft-raw-batch-grading-reference-anchored-iterative-matching-loop/files solutions_and_explanations/exercise_4_lightcraft-raw-batch-grading-reference-anchored-iterative-matching-loop/output/run_ex4.log "npx tsx run_ex4.ts"
run solutions_and_explanations/exercise_5_filmcraft-timeline-edit-point-qa-multimodal-continuity-audit-and-ripple-trim-aut/files solutions_and_explanations/exercise_5_filmcraft-timeline-edit-point-qa-multimodal-continuity-audit-and-ripple-trim-aut/output/run_ex5.log "npx tsx run_ex5.ts"
run solutions_and_explanations/exercise_6_capstone_optional_cross_applicatio/files solutions_and_explanations/exercise_6_capstone_optional_cross_applicatio/output/run_ex6.log "npx tsx run_ex6.ts"
