#!/bin/sh
# Runs every harness in chapter 5 and prints the last line of each log.
set -e
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"
PY=$("$ROOT/../tools/pick_python.sh")
: "${PY:?Python 3.10+ is required for exercise 2}"

run() {
  dir="$ROOT/$1"; log="$ROOT/$2"
  mkdir -p "$(dirname "$log")"
  ( cd "$dir" && eval "$3" ) > "$log" 2>&1
  printf '%-18s %s\n' "$(basename "$log" .log)" "$(tail -1 "$log")"
}

run basic_code_example/example/files basic_code_example/example/output/run_basic.log "npx tsx run_basic.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_advanced.log "npx tsx run_advanced.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_router.log "npx tsx run_router.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_route.log "npx tsx run_route.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_workflow.log "npx tsx run_workflow.ts"
run advanced_application_implementation/example/files advanced_application_implementation/example/output/run_shell.log "npx tsx run_shell.ts"
run solutions_and_explanations/exercise_1_building-a-schema-compatible-mcp-tool-adapter-for-cross-app-command-discovery/files solutions_and_explanations/exercise_1_building-a-schema-compatible-mcp-tool-adapter-for-cross-app-command-discovery/output/run_discovery.log "npx tsx run_discovery.ts"
run solutions_and_explanations/exercise_2_an-authenticated-tcp-loopback-client-with-session-immutability-and-reconnection-/files solutions_and_explanations/exercise_2_an-authenticated-tcp-loopback-client-with-session-immutability-and-reconnection-/output/run_ex2.log "$PY run_ex2.py"
run solutions_and_explanations/exercise_3_an-autonomous-multimodal-correction-loop-using-ui-screenshot-vision-auditing-and/files solutions_and_explanations/exercise_3_an-autonomous-multimodal-correction-loop-using-ui-screenshot-vision-auditing-and/output/run_ex3.log "npx tsx run_ex3.ts"
run solutions_and_explanations/exercise_4_parallel-tool-execution-and-atomic-batches-across-a-mixed-app-document-factory/files solutions_and_explanations/exercise_4_parallel-tool-execution-and-atomic-batches-across-a-mixed-app-document-factory/output/run_ex4.log "npx tsx run_ex4.ts"
run solutions_and_explanations/exercise_5_a-resource-and-prompt-aware-mcp-server-for-a-design-system-library-with-principl/files solutions_and_explanations/exercise_5_a-resource-and-prompt-aware-mcp-server-for-a-design-system-library-with-principl/output/run_ex5.log "npx tsx run_ex5.ts"
