#!/bin/sh
# Print the path of a Python 3.10+ interpreter.
#
# Some of the listings use `dataclasses.dataclass(slots=True)` and PEP
# 604 unions (`float | None`), so 3.10 is the floor. macOS still ships
# 3.9 as its system `python3`, so a newer interpreter is looked up on the
# PATH first.
#
# The repository's own virtual environment wins when it exists: it holds
# the third-party packages the listings import (Pillow, numpy,
# jsonschema, pydantic, the OpenAI SDK, the MCP SDK, asyncpg), and it is
# built by tools/install_python_deps.sh.
#
#   PY=$(tools/pick_python.sh)
#   "$PY" run_ex2.py
#
# Set PYTHON to override the choice.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [ -n "${PYTHON:-}" ]; then
  printf '%s\n' "$PYTHON"
  exit 0
fi

if [ -x "$ROOT/.venv/bin/python" ]; then
  printf '%s\n' "$ROOT/.venv/bin/python"
  exit 0
fi

for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    command -v "$candidate"
    exit 0
  fi
done

echo "no Python 3.10+ interpreter found on the PATH" >&2
echo "run \"tools/install_python_deps.sh\" to build the repository's environment" >&2
exit 1
