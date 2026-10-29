#!/bin/sh
# Runs every harness in chapter 12 and prints the last line of each log.
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
run solutions_and_explanations/exercise_1_transcript-driven-b-roll-assembly-with-semantic-cut-point-discovery/files solutions_and_explanations/exercise_1_transcript-driven-b-roll-assembly-with-semantic-cut-point-discovery/output/run_exercise1.log "npx tsx run_exercise1.ts"
run solutions_and_explanations/exercise_2_multi-camera-interview-sync-via-audio-cross-correlation-and-angle-mapping/files solutions_and_explanations/exercise_2_multi-camera-interview-sync-via-audio-cross-correlation-and-angle-mapping/output/run_ex2.log "$PY run_ex2.py"
run solutions_and_explanations/exercise_3_beat-aligned-ripple-trim-batch-with-undo-stack-integrity-verification/files solutions_and_explanations/exercise_3_beat-aligned-ripple-trim-batch-with-undo-stack-integrity-verification/output/run_ex3.log "$PY run_ex3.py"
run solutions_and_explanations/exercise_4_multimodal-cut-verification-with-vision-language-model-feedback-and-atomic-shot-/files solutions_and_explanations/exercise_4_multimodal-cut-verification-with-vision-language-model-feedback-and-atomic-shot-/output/run_exercise4.log "npx tsx run_exercise4.ts"
run solutions_and_explanations/exercise_5_wasm-simd-accelerated-segment-classification-for-automatic-b-roll-selection/files solutions_and_explanations/exercise_5_wasm-simd-accelerated-segment-classification-for-automatic-b-roll-selection/output/run_ex5.log "npx tsx run_ex5.ts"

exit "$FAILED"
