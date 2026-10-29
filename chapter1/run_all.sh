#!/bin/sh
# Runs every harness in chapter 1 and prints the last line of each log.
set -e
fail=0
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

run() {
  dir="$ROOT/$1"; log="$ROOT/$2"
  mkdir -p "$(dirname "$log")"
  if [ ! -d "$dir" ]; then
    printf '%-18s %s\n' "$(basename "$log" .log)" "skipped (no such project)"
    return 0
  fi
  if ( cd "$dir" && eval "$3" ) > "$log" 2>&1; then
    printf '%-18s %s\n' "$(basename "$log" .log)" "$(tail -1 "$log")"
  else
    printf '%-18s %s\n' "$(basename "$log" .log)" "FAILED — see $log"
    fail=1
  fi
}

# The two chapter examples: deterministic engine paths only. The LLM-driven
# route and brief scripts need an API key and are documented in the project
# READMEs rather than run here.
run basic_code_example/example/files \
    basic_code_example/example/output/run_probe.log \
    "node examples/mcp-probe.mjs"
run basic_code_example/example/files \
    basic_code_example/example/output/run_master.log \
    "node examples/master-probe.mjs"
run advanced_application_implementation/example/files \
    advanced_application_implementation/example/output/run_smoke.log \
    "npm run smoke"
run advanced_application_implementation/example/files \
    advanced_application_implementation/example/output/run_forge.log \
    "npm run forge:real"
run advanced_application_implementation/example/files \
    advanced_application_implementation/example/output/run_ledger.log \
    "node jobs/LF-42/setup.mjs && bash scripts/forge.sh jobs/LF-42/job.local.json"

run solutions_and_explanations/exercise_1_the-disposable-banner-autopsy-rebuilding-a-flat-generation-as-a-layered-pcraft-a/files \
    solutions_and_explanations/exercise_1_the-disposable-banner-autopsy-rebuilding-a-flat-generation-as-a-layered-pcraft-a/output/run_photocraft.log \
    "node run_photocraft.mjs"
run solutions_and_explanations/exercise_2_autonomous-drift-correction-via-multimodal-feedback-a-vision-guided-photocraft-t/files \
    solutions_and_explanations/exercise_2_autonomous-drift-correction-via-multimodal-feedback-a-vision-guided-photocraft-t/output/run_ex2.log \
    "npx tsx run_ex2.ts"
run solutions_and_explanations/exercise_3_the-undoable-grade-filmcraft-timeline-ripple-with-live-lumetri-layers/files \
    solutions_and_explanations/exercise_3_the-undoable-grade-filmcraft-timeline-ripple-with-live-lumetri-layers/output/run_ex3.log \
    "npx tsx run_ex3.ts"
run solutions_and_explanations/exercise_4_the-brand-family-problem-vectorcraft-image-trace-to-non-destructive-logo-system/files \
    solutions_and_explanations/exercise_4_the-brand-family-problem-vectorcraft-image-trace-to-non-destructive-logo-system/output/run_ex4.log \
    "npx tsx run_ex4.ts"
run solutions_and_explanations/exercise_5_lineage-first-batch-wordcraft-pdfcraft-docx-pdf-with-a-signed-provenance-manifes/files \
    solutions_and_explanations/exercise_5_lineage-first-batch-wordcraft-pdfcraft-docx-pdf-with-a-signed-provenance-manifes/output/run_ex5.log \
    "npx tsx run_ex5.ts"
run appendix_the_loopback_control_channel_with_ma/example/files \
    appendix_the_loopback_control_channel_with_ma/example/output/run_loopback.log \
    "bash run_loopback.sh"

# Last, assert that the two examples actually left the artefacts the chapter
# promises in their output folders.
run . verify_examples.log "node verify_examples.mjs"

exit "$fail"
