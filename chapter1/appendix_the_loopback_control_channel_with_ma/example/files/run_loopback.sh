#!/usr/bin/env bash
# run_loopback.sh — start `photocraft-cli serve`, drive the full loopback
# round-trip, and keep the artifacts in ../output.
#
#   bash run_loopback.sh
#
# Env: PHOTOCRAFT_BIN (default photocraft-cli), CRAFT_CONTROL_PORT (default 7979),
#      RUN_OUTPUT (default <this dir>/../output).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${RUN_OUTPUT:-$(cd "$here/.." && pwd)/output}"
port="${CRAFT_CONTROL_PORT:-7979}"
token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"

mkdir -p "$out"
"${PHOTOCRAFT_BIN:-photocraft-cli}" serve --port "$port" --control-token "$token" \
  --automation-read-root "$here" --automation-write-root "$out" >"$out/serve.log" 2>&1 &
srv=$!
trap 'kill "$srv" 2>/dev/null || true' EXIT
sleep 2

CRAFT_CONTROL_PORT="$port" CRAFT_CONTROL_TOKEN="$token" python3 "$here/03_loopback_roundtrip.py"
png=$(find "$out" -maxdepth 1 -name '*.png' | head -1)
if [ -n "$png" ]; then
  printf 'loopback round-trip complete — %s, %s bytes\n' \
    "$(basename "$png")" "$(wc -c < "$png" | tr -d ' ')"
else
  echo "loopback round-trip complete"
fi
