#!/usr/bin/env bash
# Download a pinned Node.js into tools/node so the book examples run with
# the runtime they expect — without touching the system Node.
#
#   tools/install_node.sh              # install what is missing
#   tools/install_node.sh --check      # verify what is installed
#
# Node 22.5 is the floor: chapter 20's brand store is built on SQLite's
# bundled driver, which Node exposes from 22.5 onwards. The tarball is
# verified against the SHA-256 published on nodejs.org.
#
# Set NODE_VERSION to install a different release and NODE_MIRROR to
# fetch it from a mirror:
#
#   NODE_VERSION=22.23.3 NODE_MIRROR=https://npmmirror.com/mirrors/node tools/install_node.sh
#
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/node"

VERSION="${NODE_VERSION:-22.23.3}"
MIRROR="${NODE_MIRROR:-https://nodejs.org/dist}"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM="darwin-arm64" ;;
  Darwin-x86_64) PLATFORM="darwin-x64" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

if [ "$MODE" = "check" ]; then
  if [ -x "$DEST/bin/node" ]; then
    printf 'ok  %s\n' "$("$DEST/bin/node" --version)"
    exit 0
  fi
  echo "MISSING  $DEST/bin/node"
  exit 1
fi

if [ -x "$DEST/bin/node" ] && [ "$("$DEST/bin/node" --version)" = "v$VERSION" ]; then
  echo "== node $VERSION already present, skipping"
  exit 0
fi

TARBALL="node-v${VERSION}-${PLATFORM}.tar.gz"
URL="${MIRROR%/}/v${VERSION}/${TARBALL}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== node $VERSION ($PLATFORM)"
curl -fsSL "$URL" -o "$TMP/$TARBALL"

# The checksums nodejs.org publishes for this release.
SHASUMS_URL="${MIRROR%/}/v${VERSION}/SHASUMS256.txt"
if curl -fsSL "$SHASUMS_URL" -o "$TMP/SHASUMS256.txt" 2>/dev/null; then
  want="$(awk -v f="$TARBALL" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")"
  got="$(shasum -a 256 "$TMP/$TARBALL" | awk '{ print $1 }')"
  if [ -z "$want" ]; then
    echo "   FAILED: $TARBALL is not listed in SHASUMS256.txt" >&2
    exit 1
  fi
  if [ "$want" != "$got" ]; then
    echo "   FAILED: checksum mismatch" >&2
    echo "          expected $want" >&2
    echo "          actual   $got" >&2
    exit 1
  fi
  echo "   checksum ok"
else
  echo "   WARNING: SHASUMS256.txt is unavailable, skipping the checksum" >&2
fi

rm -rf "$DEST"
tar -xzf "$TMP/$TARBALL" -C "$TMP"
mv "$TMP/node-v${VERSION}-${PLATFORM}" "$DEST"
"$DEST/bin/node" --version
echo "   -> $DEST/bin/node"
