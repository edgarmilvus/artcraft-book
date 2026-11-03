#!/bin/sh
# Runs every code path in the book that needs a real model.
#
# `run_all.sh` is the deterministic suite: real engines, scripted models, no
# network and no key. This script is the other half — the entry points that
# talk to an OpenAI-compatible endpoint and therefore cost money and vary
# from run to run. It is never called by `run_all.sh`, and `run_all.sh` never
# contacts a provider.
#
#   ./run_live.sh                 # every stage it can run
#   ./run_live.sh --list          # what would run, and what it needs
#   ./run_live.sh --only ch5-brief
#   ./run_live.sh --dry           # print the commands, execute nothing
#
# Configuration, highest priority first:
#   1. variables already exported in your shell
#   2. $ARTCRAFT_LIVE_ENV            (default ~/.config/artcraft/live.env)
#   3. tools/secrets.env
#
# A stage needs some subset of:
#   OPENAI_COMPATIBLE_API_KEY  OPENAI_COMPATIBLE_BASE_URL
#   OPENAI_COMPATIBLE_MODEL    OPENAI_COMPATIBLE_VISION_MODEL
#   EMBEDDING_API_KEY  EMBEDDING_BASE_URL  EMBEDDING_MODEL
#   PG_DSN             SEED_PHOTO_IDS
#
# Deliberately not stages: chapter 15's gate needs an EffectCraft project
# already open (the book ships the gate, not a project), and chapters 10 and
# 12 have no CLI entry — their model paths are exercised through injected
# dependencies in `run_all.sh`.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
export PATH="$ROOT/tools/craft-cli/bin:$ROOT/tools/node/bin:$PATH"

ONLY=""
DRY=0
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY="${2:-}"; shift 2 ;;
    --only=*) ONLY="${1#--only=}"; shift ;;
    --dry) DRY=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

CORE="OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL"
VISION="OPENAI_COMPATIBLE_VISION_MODEL"
EMBED="EMBEDDING_API_KEY EMBEDDING_BASE_URL EMBEDDING_MODEL"

# ── configuration ───────────────────────────────────────────────────────────
load_env() {
  [ -f "$1" ] || return 0
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
    eval "current=\${$key-}"
    [ -n "$current" ] && continue
    export "$key=$val"
  done < "$1"
}

load_env "${ARTCRAFT_LIVE_ENV:-$HOME/.config/artcraft/live.env}"
load_env "$ROOT/tools/secrets.env"

# Prints the first missing variable, or nothing when the list is satisfied.
missing() {
  for need in $1; do
    eval "have=\${$need-}"
    [ -n "$have" ] || { printf '%s' "$need"; return 0; }
  done
  return 0
}

# name | directory | required variables | command
STAGES=$(cat <<'EOF'
ch1-layered-render|chapter1/basic_code_example/example/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL|node examples/llm-layered-render.mjs
ch1-brief|chapter1/advanced_application_implementation/example/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL|node examples/llm-brief.mjs
ch1-route-render|chapter1/basic_code_example/example/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL|npx tsx examples/llm-route.ts
ch1-route-brief|chapter1/advanced_application_implementation/example/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL|npx tsx examples/llm-route.ts
ch2-vision-loop|chapter2/solutions_and_explanations/exercise_3_authenticated-tcp-loopback-agent-with-vision-in-the-loop-curve-correction/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL OPENAI_COMPATIBLE_VISION_MODEL|LIVE=1 python3 run_ex3.py
ch3-curve-grading|chapter3/solutions_and_explanations/exercise_2_autonomous-curve-grading-with-a-vision-language-feedback-loop-over-the-tcp-contr/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL OPENAI_COMPATIBLE_VISION_MODEL|LIVE=1 python3 run_live.py
ch5-brief|chapter5/advanced_application_implementation/example/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL|npx tsx run_live.ts
ch6-vision-audit|chapter6/advanced_application_implementation/example/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL OPENAI_COMPATIBLE_VISION_MODEL|npx tsx run_live.ts
ch7-qa-loop|chapter7/basic_code_example/example/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL OPENAI_COMPATIBLE_VISION_MODEL|npx tsx 01_multimodal-qa-hello-world.ts
ch9-culling|chapter9/solutions_and_explanations/exercise_2_autonomous-culling-agent-with-geometry-aware-burst-selection/files|OPENAI_COMPATIBLE_API_KEY OPENAI_COMPATIBLE_BASE_URL OPENAI_COMPATIBLE_MODEL OPENAI_COMPATIBLE_VISION_MODEL PG_DSN SEED_PHOTO_IDS|npx tsx 02_autonomous-culling-agent-with-geometry-aware-burst-selection.ts
EOF
)

if [ "$LIST" = 1 ]; then
  printf '%-20s %-34s %s\n' STAGE DIRECTORY NEEDS
  while IFS='|' read -r name dir needs cmd; do
    [ -n "$name" ] || continue
    printf '%-20s %-34s %s\n' "$name" "$dir" "$needs"
  done <<EOF
$STAGES
EOF
  exit 0
fi

GAP=$(missing "$CORE")
if [ -n "$GAP" ]; then
  printf 'run_live: %s is not set.\n' "$GAP" >&2
  printf 'Put the OPENAI_COMPATIBLE_* variables in %s, or export them.\n' \
    "${ARTCRAFT_LIVE_ENV:-$HOME/.config/artcraft/live.env}" >&2
  exit 2
fi

STAMP=$(date +%Y%m%d-%H%M%S)
LOGDIR="$ROOT/live/$STAMP"
[ "$DRY" = 1 ] || mkdir -p "$LOGDIR"

failed=0
matched=0

while IFS='|' read -r name dir needs cmd; do
  [ -n "$name" ] || continue
  if [ -n "$ONLY" ] && [ "$ONLY" != "$name" ]; then continue; fi
  matched=1

  if [ ! -d "$ROOT/$dir" ]; then
    printf '%-20s %s\n' "$name" "skipped (no such directory)"
    continue
  fi

  GAP=$(missing "$needs")
  if [ -n "$GAP" ]; then
    printf '%-20s %s\n' "$name" "skipped (needs $GAP)"
    continue
  fi

  if [ "$DRY" = 1 ]; then
    printf '%-20s (cd %s && %s)\n' "$name" "$dir" "$cmd"
    continue
  fi

  log="$LOGDIR/$name.log"
  if ( cd "$ROOT/$dir" && eval "$cmd" ) > "$log" 2>&1; then
    summary=$(grep -v '^[[:space:]]*$' "$log" | tail -1)
    case "$summary" in "{"|"}"|"[]"|"null") summary="ok" ;; esac
    printf '%-20s %s\n' "$name" "${summary:-ok}"
  else
    printf '%-20s %s\n' "$name" "FAILED — see live/$STAMP/$name.log"
    failed=1
  fi
done <<EOF
$STAGES
EOF

if [ -n "$ONLY" ] && [ "$matched" = 0 ]; then
  echo "run_live: no stage named '$ONLY' (try --list)" >&2
  exit 2
fi

if [ "$DRY" = 1 ]; then
  exit 0
fi

if [ "$failed" = 1 ]; then
  printf '\nOne or more stages failed. Logs: live/%s/\n' "$STAMP"
  exit 1
fi
printf '\nAll stages passed. Logs: live/%s/\n' "$STAMP"
