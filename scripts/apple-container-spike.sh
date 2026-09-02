#!/bin/sh
set -eu

# Optional local compatibility spike. This file does not change production OCI builds.
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DOCKERFILE=${APPLE_CONTAINER_DOCKERFILE:-"$ROOT_DIR/rust/Dockerfile"}
CONTEXT_DIR=${APPLE_CONTAINER_CONTEXT:-"$ROOT_DIR/rust"}
IMAGE=${APPLE_CONTAINER_IMAGE:-"kortix-rust-health:apple-container-spike"}
CONTAINER_NAME=${APPLE_CONTAINER_NAME:-"kortix-rust-health-spike-$$"}
HOST_PORT=${APPLE_CONTAINER_HOST_PORT:-18080}
CONTAINER_PORT=${APPLE_CONTAINER_PORT:-8008}
HEALTH_PATH=${APPLE_CONTAINER_HEALTH_PATH:-/health}
MAX_ATTEMPTS=${APPLE_CONTAINER_HEALTH_ATTEMPTS:-30}
HOST_OS=${APPLE_CONTAINER_HOST_OS:-$(uname -s)}
HOST_ARCH=${APPLE_CONTAINER_HOST_ARCH:-$(uname -m)}

skip() {
  printf 'SKIP: Apple Container spike: %s\n' "$1"
  exit 0
}

fail() {
  printf 'ERROR: Apple Container spike: %s\n' "$1" >&2
  exit 1
}

[ "$HOST_OS" = Darwin ] || skip "requires macOS 26 on Apple silicon (host OS: $HOST_OS)"
[ "$HOST_ARCH" = arm64 ] || skip "requires Apple silicon (host architecture: $HOST_ARCH)"

if [ -n "${APPLE_CONTAINER_MACOS_MAJOR:-}" ]; then
  MACOS_MAJOR=$APPLE_CONTAINER_MACOS_MAJOR
elif command -v sw_vers >/dev/null 2>&1; then
  MACOS_MAJOR=$(sw_vers -productVersion | awk -F. '{print $1}')
else
  skip "cannot read the macOS version because sw_vers is unavailable"
fi

case "$MACOS_MAJOR" in
  ''|*[!0-9]*) skip "cannot parse the macOS major version: $MACOS_MAJOR" ;;
esac
[ "$MACOS_MAJOR" -ge 26 ] || skip "requires macOS 26 or newer (host major version: $MACOS_MAJOR)"

if [ -n "${APPLE_CONTAINER_CLI:-}" ]; then
  CONTAINER_CLI=$APPLE_CONTAINER_CLI
  [ -x "$CONTAINER_CLI" ] || skip "container CLI is unavailable at $CONTAINER_CLI"
elif command -v container >/dev/null 2>&1; then
  CONTAINER_CLI=$(command -v container)
else
  skip "container CLI is not installed; see https://github.com/apple/container"
fi

[ -f "$DOCKERFILE" ] || fail "Dockerfile not found: $DOCKERFILE"
[ -d "$CONTEXT_DIR" ] || fail "build context not found: $CONTEXT_DIR"
command -v curl >/dev/null 2>&1 || fail "curl is required for the health check"

cleanup() {
  "$CONTAINER_CLI" stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  "$CONTAINER_CLI" delete "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

printf 'Starting Apple Container services...\n'
"$CONTAINER_CLI" system start || fail "container system start failed"

printf 'Building %s for linux/arm64...\n' "$IMAGE"
"$CONTAINER_CLI" build \
  --platform linux/arm64 \
  --file "$DOCKERFILE" \
  --tag "$IMAGE" \
  "$CONTEXT_DIR" || fail "image build failed"

IMAGE_INSPECT=$("$CONTAINER_CLI" image inspect "$IMAGE") || fail "could not inspect the built image"
printf '%s\n' "$IMAGE_INSPECT" | grep -Eiq '"architecture"[[:space:]]*:[[:space:]]*"(arm64|aarch64)"' || \
  fail "built image does not report arm64 architecture"
printf 'Verified OCI image architecture: arm64.\n'

printf 'Running %s as %s...\n' "$IMAGE" "$CONTAINER_NAME"
"$CONTAINER_CLI" run \
  --detach \
  --name "$CONTAINER_NAME" \
  --platform linux/arm64 \
  --publish "127.0.0.1:$HOST_PORT:$CONTAINER_PORT" \
  "$IMAGE" >/dev/null || fail "container failed to start"

HEALTH_URL="http://127.0.0.1:$HOST_PORT$HEALTH_PATH"
attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  STATUS=$(curl --silent --output /tmp/apple-container-health-$$ --write-out '%{http_code}' "$HEALTH_URL" || true)
  case "$STATUS" in
    2??)
      printf 'Health check passed: GET %s returned HTTP %s.\n' "$HEALTH_URL" "$STATUS"
      cat /tmp/apple-container-health-$$
      printf '\n'
      rm -f /tmp/apple-container-health-$$
      for probe_path in /health/live /health/ready /v1/health; do
        probe_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
          "http://127.0.0.1:$HOST_PORT$probe_path" || true)
        case "$probe_status" in
          2??) printf 'Health check passed: GET %s returned HTTP %s.\n' "$probe_path" "$probe_status" ;;
          *) fail "GET $probe_path returned HTTP $probe_status" ;;
        esac
      done
      exit 0
      ;;
  esac
  rm -f /tmp/apple-container-health-$$
  attempt=$((attempt + 1))
  sleep 1
done

fail "GET $HEALTH_URL did not return 2xx after $MAX_ATTEMPTS attempts"
