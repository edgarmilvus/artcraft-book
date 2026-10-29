#!/usr/bin/env bash
# Download the macOS CLI ("<app>-cli") builds of the ArtCraft suite into
# tools/craft-cli/bin so the book examples can run natively (no Docker).
#
#   tools/install_craft_clis.sh            # install what is missing
#   tools/install_craft_clis.sh --check    # verify what is installed
#   tools/install_craft_clis.sh --force    # re-download everything
#
# The binaries are Apache-2.0 macOS executables from their vendor and are never committed
# to the repository. Each download is verified against the SHA-256
# recorded in tools/craft-cli/SHA256SUMS.
#
# Set CRAFT_CLI_SOURCE to install from a mirror — a GitHub Enterprise
# host, an S3 bucket, or a local directory of .zip archives:
#
#   CRAFT_CLI_SOURCE=https://github.com/storytold tools/install_craft_clis.sh
#   CRAFT_CLI_SOURCE=file:///Volumes/artcraft-releases tools/install_craft_clis.sh
#
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HERE/craft-cli"
BIN="$DEST/bin"
SUMS="$DEST/SHA256SUMS"
mkdir -p "$DEST" "$BIN"

SOURCE="${CRAFT_CLI_SOURCE:-https://github.com/storytold}"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --force) MODE="force" ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# app:version  (must match the Dockerfile ARGs)
# The versions come from tools/craft-cli/versions.txt, which the Dockerfile
# reads too: one list, so the native install and the image cannot drift.
VERSIONS_FILE="$HERE/craft-cli/versions.txt"
APPS=()
if [ -f "$VERSIONS_FILE" ]; then
  while read -r app ver rest; do
    case "$app" in ""|\#*) continue ;; esac
    [ -n "$ver" ] && APPS+=("${app}:${ver}")
  done < "$VERSIONS_FILE"
else
  echo "missing $VERSIONS_FILE" >&2
  exit 1
fi

# The SHA-256 the binary must have, if we know it.
expected_sha() {
  [ -f "$SUMS" ] || return 0
  awk -v name="$1-cli" '$2 == name { print $1 }' "$SUMS"
}

actual_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

fail=0

for spec in "${APPS[@]}"; do
  app="${spec%%:*}"
  ver="${spec##*:}"
  target="$BIN/${app}-cli"
  want="$(expected_sha "$app")"

  if [ "$MODE" = "check" ]; then
    if [ ! -x "$target" ]; then
      echo "MISSING  ${app}-cli ${ver}"
      fail=1
      continue
    fi
    got="$(actual_sha "$target")"
    if [ -n "$want" ] && [ "$got" != "$want" ]; then
      echo "MISMATCH ${app}-cli ${ver}"
      fail=1
      continue
    fi
    echo "ok       ${app}-cli ${ver}  ${got:0:16}…"
    continue
  fi

  if [ -x "$target" ] && [ "$MODE" != "force" ]; then
    got="$(actual_sha "$target")"
    if [ -z "$want" ] || [ "$got" = "$want" ]; then
      echo "== ${app}-cli already present, skipping"
      continue
    fi
    echo "== ${app}-cli present but the checksum differs, re-downloading"
  fi

  # Two layouts are tried: the per-app GitHub release page
  #   <source>/<app>/releases/download/v<ver>/<app>-cli-<ver>-macos-universal.zip
  # and a flat mirror, which is what this repository's own release uses:
  #   <source>/<app>-cli-<ver>-macos-universal.zip
  flat_url="${SOURCE%/}/${app}-cli-${ver}-macos-universal.zip"
  zip_url="${SOURCE%/}/${app}/releases/download/v${ver}/${app}-cli-${ver}-macos-universal.zip"
  outdir="$DEST/${app}-${ver}"

  echo "== ${app} ${ver}"
  mkdir -p "$outdir"
  if ! curl -fsSL "$zip_url" -o "$outdir/${app}.zip" 2>/dev/null; then
    if ! curl -fsSL "$flat_url" -o "$outdir/${app}.zip"; then
      echo "   FAILED to download: $zip_url" >&2
      echo "                     or: $flat_url" >&2
      fail=1
      continue
    fi
  fi
  unzip -o -q "$outdir/${app}.zip" -d "$outdir"
  rm -f "$outdir/${app}.zip"

  src="$(find "$outdir" -type f -name "${app}-cli" | head -n 1)"
  if [ -z "$src" ]; then
    echo "   FAILED: no ${app}-cli inside the archive" >&2
    fail=1
    continue
  fi

  if [ -n "$want" ]; then
    got="$(actual_sha "$src")"
    if [ "$got" != "$want" ]; then
      echo "   FAILED: checksum mismatch for ${app}-cli" >&2
      echo "          expected $want" >&2
      echo "          actual   $got" >&2
      fail=1
      continue
    fi
  fi

  cp "$src" "$target"
  chmod +x "$target"
  echo "   -> $target"
done

if [ "$MODE" = "check" ]; then
  exit "$fail"
fi

echo
echo "Installed CLIs:"
ls -1 "$BIN"
