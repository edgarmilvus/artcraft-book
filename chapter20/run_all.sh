#!/bin/sh
# Runs every harness in chapter 20 and prints the last line of each log.
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
    # The last line is the assertion count, unless the harness prints a
    # hint after it.
    printf '%-18s %s\n' "$(basename "$log" .log)" "$(grep -E '^[0-9]+ assertions passed$' "$log" | tail -1)"
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

run solutions_and_explanations/exercise_1_the-banner-factory-campaign-kickoff-to-published-asset/files \
    solutions_and_explanations/exercise_1_the-banner-factory-campaign-kickoff-to-published-asset/output/run_ex1.log \
    "$PY run_ex1.py"

run solutions_and_explanations/exercise_2_the-multimodal-aesthetic-feedback-loop-closing-the-loop-between-tcp-auth-ui-scre/files \
    solutions_and_explanations/exercise_2_the-multimodal-aesthetic-feedback-loop-closing-the-loop-between-tcp-auth-ui-scre/output/run_ex2.log \
    "$PY run_ex2.py"

run solutions_and_explanations/exercise_3_autonomous-trailer-assembly-ripple-aware-tempo-synced-editing-in-filmcraft-via-m/files \
    solutions_and_explanations/exercise_3_autonomous-trailer-assembly-ripple-aware-tempo-synced-editing-in-filmcraft-via-m/output/run_ex3.log \
    "npx tsx run_ex3.ts"

run solutions_and_explanations/exercise_4_the-single-source-of-truth-publishing-pipeline-designcraft-pdfcraft-and-wordcraf/files \
    solutions_and_explanations/exercise_4_the-single-source-of-truth-publishing-pipeline-designcraft-pdfcraft-and-wordcraf/output/run_ex4.log \
    "npx tsx run_ex4.ts"

run solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/files \
    solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/output/run_ex5.log \
    "$PY run_ex5.py"

exit "$FAILED"
