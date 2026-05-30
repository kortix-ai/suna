#!/usr/bin/env bash
#
# Compile the `kortix` CLI to a self-contained binary at dist/kortix — the
# artifact the layered snapshot builder bakes into every cloud sandbox
# (apps/api/src/snapshots/providers/daytona.ts reads
# KORTIX_SNAPSHOT_CLI_BIN_PATH, default apps/cli/dist/kortix). Mirrors
# apps/kortix-sandbox-agent-server/scripts/build.sh so both runtime binaries
# are produced the same way (CI, dev-local.sh, the snapshot test harness).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

if [ -n "${BUN_COMPILE_TARGET:-}" ]; then
  target="$BUN_COMPILE_TARGET"
else
  # Default to bun-linux-x64: Daytona's standard runners are x86_64 and the
  # snapshot builder COPYs this binary verbatim into the per-project image.
  # Override with BUN_COMPILE_TARGET for a different arch (e.g. local docker
  # on Apple Silicon, or a darwin host binary).
  target="bun-linux-x64"
fi

case "$target" in
  bun-linux-x64|bun-linux-arm64|bun-darwin-x64|bun-darwin-arm64) ;;
  *)
    echo "Unsupported Bun compile target: $target" >&2
    exit 1
    ;;
esac

bun build --compile --target="$target" --outfile=dist/kortix src/index.ts
chmod +x dist/kortix
size="$(stat -f%z dist/kortix 2>/dev/null || stat -c%s dist/kortix)"
echo "Built dist/kortix for ${target} (${size} bytes)"
