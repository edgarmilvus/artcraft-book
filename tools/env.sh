#!/usr/bin/env bash
# Source this to put the local Node and the ArtCraft macOS CLIs on PATH.
#
#   source tools/env.sh
#
# Works from bash or zsh. No globals beyond PATH.
_artcraft_here="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"
export ARTCRAFT_TOOLS="$_artcraft_here"
export PATH="$_artcraft_here/craft-cli/bin:$_artcraft_here/node/bin:$PATH"
echo "ArtCraft env ready: node $(node -v 2>/dev/null || echo '?'), clis -> $_artcraft_here/craft-cli/bin"
