#!/bin/sh
# Runs every harness in chapter 9 and prints the last line of each log.
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
run solutions_and_explanations/exercise_1_headless-ingest-and-duplicate-gate/files solutions_and_explanations/exercise_1_headless-ingest-and-duplicate-gate/output/run_ex1.log "$PY run_ex1.py"
run solutions_and_explanations/exercise_2_autonomous-culling-agent-with-geometry-aware-burst-selection/files solutions_and_explanations/exercise_2_autonomous-culling-agent-with-geometry-aware-burst-selection/output/run_ex2.log "npx tsx run_ex2.ts"
run solutions_and_explanations/exercise_3_32-bit-float-linear-hdr-merge-and-gpu-accelerated-tone-mapping-chain/files solutions_and_explanations/exercise_3_32-bit-float-linear-hdr-merge-and-gpu-accelerated-tone-mapping-chain/output/run_ex3.log "$PY run_ex3.py"
run solutions_and_explanations/exercise_4_multimodal-vision-in-the-loop-grading-auditor-over-the-tcp-control-channel/files solutions_and_explanations/exercise_4_multimodal-vision-in-the-loop-grading-auditor-over-the-tcp-control-channel/output/run_ex4.log "$PY run_ex4.py"
run solutions_and_explanations/exercise_5_headless-batch-export-orchestrator-with-hnsw-accelerated-deduplication-gate/files solutions_and_explanations/exercise_5_headless-batch-export-orchestrator-with-hnsw-accelerated-deduplication-gate/output/run_ex5.log "npx tsx run_ex5.ts"

exit "$FAILED"
