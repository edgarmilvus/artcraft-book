#!/bin/sh
# Runs every chapter-4 example, exercise starter and exercise solution against
# the real engines and prints the last line of each log. Any harness failure
# makes the script exit non-zero.
set -e
fail=0
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

TSX="$ROOT/../node_modules/.bin/tsx"

run() {
  name="$1"; dir="$2"; log="$3"; cmd="$4"
  mkdir -p "$(dirname "$log")"
  if [ ! -d "$dir" ]; then
    printf '%-18s %s\n' "$name" "skipped (no such project)"
    return 0
  fi
  if ( cd "$dir" && eval "$cmd" ) > "$log" 2>&1; then
    summary="$(grep -v '^[[:space:]]*$' "$log" | tail -1)"
    printf '%-18s %s\n' "$name" "${summary:-ok}"
  else
    printf '%-18s %s\n' "$name" "FAILED — see $log"
    fail=1
  fi
}

# --- the chapter's examples -------------------------------------------------
A="$ROOT/advanced_application_implementation/example"
run advanced "$A/files" "$A/output/run_advanced.log" \
    "\"$TSX\" run_advanced.ts"
run bridge "$A/files" "$A/output/run_bridge.log" \
    "\"$TSX\" run_bridge.ts"

# --- the exercise solutions -------------------------------------------------
S="$ROOT/solutions_and_explanations"
run ex1 "$S/exercise_1_a-backpressure-aware-json-lines-channel-client-for-photocraft-banner-batch/files" "$S/exercise_1_a-backpressure-aware-json-lines-channel-client-for-photocraft-banner-batch/output/run_channel_client.log" \
    "\"$TSX\" run_channel_client.ts"
run ex2 "$S/exercise_2_autonomous-agentic-asset-resolution-claude-code-via-mcp-resolving-an-unmapped-pl/files" \
    "$S/exercise_2_autonomous-agentic-asset-resolution-claude-code-via-mcp-resolving-an-unmapped-pl/output/run_ex2.log" \
    "\"$TSX\" run_ex2.ts"
run ex3 "$S/exercise_3_multimodal-color-grading-correction-loop-for-filmcraft-using-ui-screenshot-style/files" \
    "$S/exercise_3_multimodal-color-grading-correction-loop-for-filmcraft-using-ui-screenshot-style/output/run_ex3.log" \
    "\"$TSX\" run_ex3.ts"
run ex4 "$S/exercise_4_heterogeneous-multi-engine-fan-out-with-schema-routed-commands/files" \
    "$S/exercise_4_heterogeneous-multi-engine-fan-out-with-schema-routed-commands/output/run_ex4.log" \
    "\"$TSX\" run_ex4.ts"
run ex5 "$S/exercise_5_self-healing-document-assembly-under-partial-engine-failure/files" \
    "$S/exercise_5_self-healing-document-assembly-under-partial-engine-failure/output/run_ex5.log" \
    "\"$TSX\" run_ex5.ts"

exit "$fail"
