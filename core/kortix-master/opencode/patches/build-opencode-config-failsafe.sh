#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_PATCH="$SCRIPT_DIR/opencode-config-failsafe-core.patch"
TEST_PATCH="$SCRIPT_DIR/opencode-config-failsafe-tests.patch"
VERSION="${OPENCODE_VERSION:-${1:-}}"
TARBALL_URL="${OPENCODE_SOURCE_TARBALL_URL:-https://api.github.com/repos/anomalyco/opencode/tarball/v${VERSION}}"
OUTPUT_BIN="${KORTIX_OPENCODE_OUTPUT_BIN:-/usr/local/bin/opencode-kortix}"

if [ -z "$VERSION" ]; then
  echo "[opencode-failsafe] ERROR: OPENCODE_VERSION is required"
  exit 1
fi

for patch_file in "$CORE_PATCH" "$TEST_PATCH"; do
  if [ ! -f "$patch_file" ]; then
    echo "[opencode-failsafe] ERROR: missing patch file $patch_file"
    exit 1
  fi
done

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/opencode.tar.gz"
echo "[opencode-failsafe] Downloading OpenCode source v${VERSION}..."
curl -fsSL --retry 3 --retry-delay 1 \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: kortix-opencode-build" \
  "$TARBALL_URL" \
  -o "$ARCHIVE"

tar -xzf "$ARCHIVE" -C "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

if [ -z "$SRC_DIR" ] || [ ! -d "$SRC_DIR/packages/opencode" ]; then
  echo "[opencode-failsafe] ERROR: failed to extract OpenCode source"
  exit 1
fi

echo "[opencode-failsafe] Applying fail-soft patches..."
patch --batch -d "$SRC_DIR" -p8 < "$CORE_PATCH"
patch --batch -d "$SRC_DIR" -p8 < "$TEST_PATCH"

echo "[opencode-failsafe] Installing dependencies..."
bun install --cwd "$SRC_DIR"

echo "[opencode-failsafe] Building single-platform binary..."
(
  cd "$SRC_DIR/packages/opencode"
  export OPENCODE_VERSION="$VERSION"
  export OPENCODE_CHANNEL="latest"
  bun run build --single
)

BUILT_BIN="$(find "$SRC_DIR/packages/opencode/dist" -path '*/bin/opencode' -type f | head -n 1)"
if [ -z "$BUILT_BIN" ] || [ ! -f "$BUILT_BIN" ]; then
  echo "[opencode-failsafe] ERROR: built binary not found"
  exit 1
fi

install -m 0755 "$BUILT_BIN" "$OUTPUT_BIN"
echo "[opencode-failsafe] Installed patched binary to $OUTPUT_BIN"
