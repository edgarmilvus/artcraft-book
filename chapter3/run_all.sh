#!/bin/sh
# Runs every chapter-3 example and exercise against the real engines and
# prints the last line of each log.
#
# The commands mirror the per-exercise READMEs; the log of each run is written
# next to the output it belongs to.
set -e
fail=0
ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/../tools/craft-cli/bin:$PATH"

TSX="$ROOT/../node_modules/.bin/tsx"
TSC="$ROOT/../node_modules/.bin/tsc"
PY=$("$ROOT/../tools/pick_python.sh")

# The banner services below are exercised over HTTP with curl. Without it the
# chapter would print an error where a verdict belongs and still exit 0, which
# is worse than failing outright.
if ! command -v curl >/dev/null 2>&1; then
  echo "chapter3: curl is required to exercise the banner services" >&2
  exit 1
fi

SRV=""

stop_server() {
  if [ -n "$SRV" ]; then
    kill "$SRV" 2>/dev/null || true
    wait "$SRV" 2>/dev/null || true
    SRV=""
  fi
}
trap stop_server EXIT INT TERM

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

# --- the basic example: the banner service over HTTP ------------------------
B="$ROOT/basic_code_example/example"
run banner_service "$B/files" "$B/output/service.log" \
    "mkdir -p ../output/tmp;
     TMPDIR=\"\$(cd ../output/tmp && pwd)\" KEEP_WORKSPACE=1 PORT=8787 \"$TSX\" 01_banner-service.ts &
     SRV=\$!;
     for i in 1 2 3 4 5 6 7 8 9 10; do
       curl -sS -o /dev/null http://localhost:8787/ 2>/dev/null && break
       sleep 1
     done;
     curl -fsS -X POST http://localhost:8787/banner -H 'content-type: application/json' \
       -d '{\"headline\":\"Hello, World\",\"subhead\":\"Rendered by PhotoCraft\",\"width\":1200,\"height\":630}' \
       || { kill \$SRV 2>/dev/null || true; exit 1; };
     kill \$SRV 2>/dev/null || true;
     wait \$SRV 2>/dev/null || true"

# --- the advanced application: BannerForge ----------------------------------
A="$ROOT/advanced_application_implementation/example"
run bannerforge "$A/files" "$A/output/server-dist.log" \
    "OUT=\"\$(cd ../output && pwd)\";
     rm -rf \"\$OUT/out/banners\" \"\$OUT/out/stage-a\";
     \"$TSC\" -p tsconfig.build.json;
     CRAFT_IN_ROOT=\"\$OUT/in\" CRAFT_OUT_ROOT=\"\$OUT/out\" PORT=8081 node dist/index.js &
     SRV=\$!;
     for i in 1 2 3 4 5 6 7 8 9 10; do
       curl -sS -o /dev/null http://localhost:8081/ 2>/dev/null && break
       sleep 1
     done;
     rm -f \"\$OUT/responses.jsonl\";
     for i in 1 2 3; do
       curl -fsS -X POST http://localhost:8081/v1/render -H 'content-type: application/json' \
         -d '{\"tenantId\":\"acme\",\"headline\":\"Summer Sale\",\"subhead\":\"Velvet chair, ochre\",
              \"price\":\"\$1199\",\"productImagePath\":\"chair.png\",\"accentColor\":\"#b8751f\"}' \
         > \"\$OUT/artifact-response-\$i.json\" \
         || { kill \$SRV 2>/dev/null || true; exit 1; };
       cat \"\$OUT/artifact-response-\$i.json\" >> \"\$OUT/responses.jsonl\";
       echo >> \"\$OUT/responses.jsonl\";
     done;
     cp \"\$OUT/artifact-response-3.json\" \"\$OUT/artifact.json\";
     rm -f \"\$OUT\"/artifact-response-*.json;
     kill \$SRV 2>/dev/null || true;
     wait \$SRV 2>/dev/null || true"

# --- the exercises ----------------------------------------------------------
S="$ROOT/solutions_and_explanations"
run ex1 "$S/exercise_1_the-banner-factory-manifest-12-000-deterministic-derivatives-per-cycle/files" "$S/exercise_1_the-banner-factory-manifest-12-000-deterministic-derivatives-per-cycle/output/run_ex1.log" \
    "\"$TSX\" run_ex1.ts"
run ex2 "$S/exercise_2_autonomous-curve-grading-with-a-vision-language-feedback-loop-over-the-tcp-contr/files" \
    "$S/exercise_2_autonomous-curve-grading-with-a-vision-language-feedback-loop-over-the-tcp-contr/output/run_ex2.log" \
    "\"$PY\" run_ex2.py"
run ex3 "$S/exercise_3_the-publishing-house-nightly-pipeline-wordcraft-designcraft-pdfcraft-with-prefli/files" \
    "$S/exercise_3_the-publishing-house-nightly-pipeline-wordcraft-designcraft-pdfcraft-with-prefli/output/run_ex3.log" \
    "\"$TSX\" run_ex3.ts"
run ex4 "$S/exercise_4_warm-start-encoder-container-typed-headless-inference-with-strict-null-checks/files" \
    "$S/exercise_4_warm-start-encoder-container-typed-headless-inference-with-strict-null-checks/output/run_ex4.log" \
    "\"$TSX\" run_ex4.ts"
run ex5 "$S/exercise_5_versioned-artifact-publishing-with-signed-provenance-and-failure-semantics-in-gi/files" \
    "$S/exercise_5_versioned-artifact-publishing-with-signed-provenance-and-failure-semantics-in-gi/output/run_ex5.log" \
    "\"$TSX\" run_ex5.ts"
run ex6 "$S/exercise_6_cross-suite-regression-harness-golden-file-diffing-across-designcraft-pdfcraft-a/files" \
    "$S/exercise_6_cross-suite-regression-harness-golden-file-diffing-across-designcraft-pdfcraft-a/output/run_ex6.log" \
    "\"$TSX\" run_ex6.ts"

exit "$fail"
