#!/bin/sh
# Runs every chapter-2 example and exercise against the real engines and
# prints the last line of each log.
#
# The commands are the ones printed at the top of each project README; the log
# of each run is written next to the project it belongs to.
set -e
fail=0
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

TSX="$ROOT/../node_modules/.bin/tsx"
PY=$("$ROOT/../tools/pick_python.sh")

run() {
  name="$1"; dir="$2"; log="$3"; cmd="$4"
  mkdir -p "$(dirname "$log")"
  if [ ! -d "$dir" ]; then
    printf '%-18s %s\n' "$name" "skipped (no such project)"
    return 0
  fi
  if ( cd "$dir" && eval "$cmd" ) > "$log" 2>&1; then
    summary="$(grep -v '^[[:space:]]*$' "$log" | tail -1)"
    case "$summary" in
      "{" | "}" | "[]") summary="ok" ;;
    esac
    printf '%-18s %s\n' "$name" "${summary:-ok}"
  else
    printf '%-18s %s\n' "$name" "FAILED — see $log"
    fail=1
  fi
}

# --- the basic example ------------------------------------------------------
B="$ROOT/basic_code_example/example"
run hello "$B/files" "$B/output/run.log" \
    "OUT_DIR=\"\$(cd ../output && pwd)\" \"$TSX\" 01_hello-artcraft-arch.ts"
run pitfalls "$B/files" "$B/output/verify-pitfalls.log" \
    "node verify-pitfalls.mjs"
run zombie "$B/files" "$B/output/run-zombie.log" \
    "\"$TSX\" 04_6_zombie_child_processes_on_time.ts"

# --- the advanced application ----------------------------------------------
A="$ROOT/advanced_application_implementation/example"
run factory "$A/files" "$A/output/run-factory.log" \
    "\"$TSX\" run-factory.ts"

# --- the exercises ----------------------------------------------------------
S="$ROOT/solutions_and_explanations"
run sparse_tile "$S/exercise_1_sparse-tile-memory-delta-harness-for-interactive-undo-budgets/files" \
    "$S/exercise_1_sparse-tile-memory-delta-harness-for-interactive-undo-budgets/output/run_ex1.log" \
    "\"$PY\" run_ex1.py"
run parity "$S/exercise_2_dual-compositor-parity-audit-between-cpu-oracle-and-gpu-pipelines/files" \
    "$S/exercise_2_dual-compositor-parity-audit-between-cpu-oracle-and-gpu-pipelines/output/run_ex2.log" \
    "\"$TSX\" run_ex2.ts"
run loopback "$S/exercise_3_authenticated-tcp-loopback-agent-with-vision-in-the-loop-curve-correction/files" \
    "$S/exercise_3_authenticated-tcp-loopback-agent-with-vision-in-the-loop-curve-correction/output/run_ex3.log" \
    "\"$PY\" run_ex3.py"
run registry "$S/exercise_4_command-registry-topology-mapping-for-mcp-aware-agents/files" \
    "$S/exercise_4_command-registry-topology-mapping-for-mcp-aware-agents/output/run_ex4.log" \
    "\"$PY\" run_ex4.py"
run bundle "$S/exercise_5_cross-suite-autonomous-asset-resolution-pipeline-with-sandboxed-file-roots/files" \
    "$S/exercise_5_cross-suite-autonomous-asset-resolution-pipeline-with-sandboxed-file-roots/output/run_ex5.log" \
    "\"$TSX\" run_ex5.ts"

exit "$fail"
