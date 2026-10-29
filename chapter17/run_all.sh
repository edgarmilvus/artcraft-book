#!/bin/sh
# Runs every harness in chapter 17 and prints the last line of each log.
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
    "npx tsx run_nimbus.ts"

run solutions_and_explanations/exercise_1_contract-lifecycle-compiler-nightly-crm-engagement-letter-sealing/files \
    solutions_and_explanations/exercise_1_contract-lifecycle-compiler-nightly-crm-engagement-letter-sealing/output/run_ex1.log \
    "npx tsx run_ex1.ts"

run solutions_and_explanations/exercise_2_agentic-pii-redaction-regulatory-compliance-audit/files \
    solutions_and_explanations/exercise_2_agentic-pii-redaction-regulatory-compliance-audit/output/run_ex2.log \
    "$PY run_ex2.py"

run solutions_and_explanations/exercise_3_multimodal-financial-report-assembly-with-live-chart-ingestion/files \
    solutions_and_explanations/exercise_3_multimodal-financial-report-assembly-with-live-chart-ingestion/output/run_ex3.log \
    "npx tsx run_ex3.ts"

run solutions_and_explanations/exercise_4_digital-signature-ledger-with-trust-store-reconciliation/files \
    solutions_and_explanations/exercise_4_digital-signature-ledger-with-trust-store-reconciliation/output/run_ex4.log \
    "$PY run_ex4.py"

run solutions_and_explanations/exercise_5_autonomous-regulatory-submission-compiler-with-ocr-fallback-and-form-population/files \
    solutions_and_explanations/exercise_5_autonomous-regulatory-submission-compiler-with-ocr-fallback-and-form-population/output/run_ex5.log \
    "$PY run_ex5.py"

exit "$FAILED"
