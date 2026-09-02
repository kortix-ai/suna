#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRIPT="$ROOT_DIR/scripts/apple-container-spike.sh"
TMP_DIR=${TMPDIR:-/tmp}/apple-container-spike-test-$$
mkdir -p "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

assert_skip() {
  expected=$1
  shift
  output=$(env "$@" "$SCRIPT")
  printf '%s\n' "$output" | grep -F "SKIP: Apple Container spike: $expected" >/dev/null || {
    printf 'Expected skip message not found. Output:\n%s\n' "$output" >&2
    exit 1
  }
}

assert_skip 'requires macOS 26 on Apple silicon (host OS: Linux)' \
  APPLE_CONTAINER_HOST_OS=Linux APPLE_CONTAINER_HOST_ARCH=x86_64
assert_skip 'requires Apple silicon (host architecture: x86_64)' \
  APPLE_CONTAINER_HOST_OS=Darwin APPLE_CONTAINER_HOST_ARCH=x86_64
assert_skip 'requires macOS 26 or newer (host major version: 25)' \
  APPLE_CONTAINER_HOST_OS=Darwin APPLE_CONTAINER_HOST_ARCH=arm64 \
  APPLE_CONTAINER_MACOS_MAJOR=25
assert_skip "container CLI is unavailable at $TMP_DIR/missing-container" \
  APPLE_CONTAINER_HOST_OS=Darwin APPLE_CONTAINER_HOST_ARCH=arm64 \
  APPLE_CONTAINER_MACOS_MAJOR=26 APPLE_CONTAINER_CLI="$TMP_DIR/missing-container"

FAKE_CONTAINER="$TMP_DIR/container"
printf '#!/bin/sh\nexit 0\n' > "$FAKE_CONTAINER"
chmod +x "$FAKE_CONTAINER"
if env APPLE_CONTAINER_HOST_OS=Darwin APPLE_CONTAINER_HOST_ARCH=arm64 \
  APPLE_CONTAINER_MACOS_MAJOR=26 APPLE_CONTAINER_CLI="$FAKE_CONTAINER" \
  APPLE_CONTAINER_DOCKERFILE="$TMP_DIR/missing-Dockerfile" \
  "$SCRIPT" >"$TMP_DIR/output" 2>&1; then
  printf 'Expected a missing Dockerfile error.\n' >&2
  exit 1
fi
grep -F "ERROR: Apple Container spike: Dockerfile not found: $TMP_DIR/missing-Dockerfile" \
  "$TMP_DIR/output" >/dev/null

printf 'Apple Container spike detection tests passed.\n'
