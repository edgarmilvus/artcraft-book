#!/bin/sh
# Runs every harness in chapter 10 and prints the last line of each log.
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
run solutions_and_explanations/exercise_1_feed-hygiene-gate-validating-and-normalizing-dynamic-product-feeds-before-banner/files solutions_and_explanations/exercise_1_feed-hygiene-gate-validating-and-normalizing-dynamic-product-feeds-before-banner/output/run_ex1.log "npx tsx run_ex1.ts"
run solutions_and_explanations/exercise_2_brand-locked-vector-templates-enforcing-color-type-and-safe-zone-rules-via-vecto/files solutions_and_explanations/exercise_2_brand-locked-vector-templates-enforcing-color-type-and-safe-zone-rules-via-vecto/output/run_ex2.log "npx tsx run_ex2.ts"
run solutions_and_explanations/exercise_3_long-running-asset-resolution-agent-mcp-driven-autonomous-fallback-for-missing-h/files solutions_and_explanations/exercise_3_long-running-asset-resolution-agent-mcp-driven-autonomous-fallback-for-missing-h/output/run_ex3.log "$PY run_ex3.py"
run solutions_and_explanations/exercise_4_multimodal-aesthetic-gate-vision-model-driven-loop-on-rendered-banners/files solutions_and_explanations/exercise_4_multimodal-aesthetic-gate-vision-model-driven-loop-on-rendered-banners/output/run_ex4.log "$PY run_ex4.py"
run solutions_and_explanations/exercise_5_multi-locale-multi-aspect-responsive-export-with-content-hash-cache-manifest/files solutions_and_explanations/exercise_5_multi-locale-multi-aspect-responsive-export-with-content-hash-cache-manifest/output/run_ex5.log "npx tsx run_ex5.ts"

exit "$FAILED"
