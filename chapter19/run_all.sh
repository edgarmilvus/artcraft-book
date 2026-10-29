#!/bin/sh
# Runs every harness in chapter 19 and prints the last line of each log.
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
    "npx tsx run_governor.ts"

run solutions_and_explanations/exercise_1_federated-mcp-fleet-governance-one-policy-three-ide-configs/files \
    solutions_and_explanations/exercise_1_federated-mcp-fleet-governance-one-policy-three-ide-configs/output/run_ex1.log \
    "npx tsx run_ex1.ts"

run solutions_and_explanations/exercise_2_autonomous-asset-remediation-in-designcraft-with-claude-code-and-command-batch/files \
    solutions_and_explanations/exercise_2_autonomous-asset-remediation-in-designcraft-with-claude-code-and-command-batch/output/run_ex2.log \
    "$PY run_ex2.py"

run solutions_and_explanations/exercise_3_multimodal-colour-grading-loop-with-lightcraft-tcp-auth-and-a-vision-llm/files \
    solutions_and_explanations/exercise_3_multimodal-colour-grading-loop-with-lightcraft-tcp-auth-and-a-vision-llm/output/run_ex3.log \
    "$PY run_ex3.py"

run solutions_and_explanations/exercise_4_supervisor-worker-delegation-for-filmcraft-timeline-assembly/files \
    solutions_and_explanations/exercise_4_supervisor-worker-delegation-for-filmcraft-timeline-assembly/output/run_ex4.log \
    "npx tsx run_ex4.ts"

run solutions_and_explanations/exercise_5_policy-enforced-batch-redaction-and-archive-with-pdfcraft-headless-opencode-and-/files \
    solutions_and_explanations/exercise_5_policy-enforced-batch-redaction-and-archive-with-pdfcraft-headless-opencode-and-/output/run_ex5.log \
    "$PY run_ex5.py"

run solutions_and_explanations/exercise_6_cross-suite-asset-provenance-ledger/files \
    solutions_and_explanations/exercise_6_cross-suite-asset-provenance-ledger/output/run_ex6.log \
    "npx tsx run_ex6.ts"

exit "$FAILED"
