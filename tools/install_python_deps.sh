#!/usr/bin/env bash
# Build the repository's Python environment.
#
#   tools/install_python_deps.sh            # create .venv and install
#   tools/install_python_deps.sh --check    # report what is missing
#
# The book's Python listings import Pillow, numpy, jsonschema, pydantic,
# the OpenAI SDK, the MCP SDK and asyncpg. They are installed into a
# virtual environment at the repository root, and the runners pick that
# interpreter in preference to the system one — so the same code runs
# whatever the reader's system Python happens to be.
#
# Set VENV to use a different location and PYTHON to choose the
# interpreter the environment is built from.
#
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"
REQ="$HERE/requirements.txt"

pick_python() {
  if [ -n "${PYTHON:-}" ]; then printf '%s\n' "$PYTHON"; return 0; fi
  for candidate in python3.13 python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1 &&
       "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      command -v "$candidate"
      return 0
    fi
  done
  echo "no Python 3.10+ interpreter found on the PATH" >&2
  return 1
}

if [ "${1:-}" = "--check" ]; then
  if [ ! -x "$VENV/bin/python" ]; then
    echo "MISSING  $VENV"
    exit 1
  fi
  missing=0
  for module in PIL numpy jsonschema pydantic openai mcp asyncpg; do
    if "$VENV/bin/python" -c "import $module" 2>/dev/null; then
      echo "ok       $module"
    else
      echo "MISSING  $module"
      missing=1
    fi
  done
  exit "$missing"
fi

PY="$(pick_python)"
echo "== building $VENV from $PY"
if [ ! -x "$VENV/bin/python" ]; then
  "$PY" -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -r "$REQ"

echo
"$VENV/bin/python" --version
echo "   -> $VENV/bin/python"
