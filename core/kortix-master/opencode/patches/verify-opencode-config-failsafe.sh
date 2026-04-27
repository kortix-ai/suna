#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CORE_PATCH="$SCRIPT_DIR/opencode-config-failsafe-core.patch"
TEST_PATCH="$SCRIPT_DIR/opencode-config-failsafe-tests.patch"
VERSION="${OPENCODE_VERSION:-${1:-1.14.28}}"
TARBALL_URL="${OPENCODE_SOURCE_TARBALL_URL:-https://api.github.com/repos/anomalyco/opencode/tarball/v${VERSION}}"
PATTERN='skips invalid project schema config and reports diagnostics|skips invalid JSON config and reports diagnostics|migrates legacy top-level models config instead of failing|skips invalid OPENCODE_CONFIG_CONTENT and reports env diagnostics|skips invalid remote account config and reports diagnostics'

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/opencode.tar.gz"
echo "[opencode-failsafe] Downloading OpenCode source v${VERSION} for verification..."
curl -fsSL --retry 3 --retry-delay 1 \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: kortix-opencode-verify" \
  "$TARBALL_URL" \
  -o "$ARCHIVE"

tar -xzf "$ARCHIVE" -C "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

patch --batch -d "$SRC_DIR" -p1 < "$CORE_PATCH"
patch --batch -d "$SRC_DIR" -p1 < "$TEST_PATCH"

bun install --cwd "$SRC_DIR"

bun --cwd "$SRC_DIR/packages/opencode" test test/config/config.test.ts --test-name-pattern "$PATTERN"
bun --cwd "$SRC_DIR/packages/opencode" test test/server/httpapi-config.test.ts
