#!/usr/bin/env bash
#
# Shared builder. Per-platform scripts (bundle-darwin-arm64.sh etc.)
# sources this file and calls `build_target <bun-target> <outfile>`.
#
# Don't run this directly.

set -euo pipefail

# Resolve apps/cli/ regardless of where the caller lives.
CLI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="${CLI_ROOT}/src/index.ts"
OUT_DIR="${CLI_ROOT}/bundle"

build_target() {
  local target="$1"
  local outfile="$OUT_DIR/$2"
  echo "  ↻ ${target}  →  bundle/$2"
  bun build "$ENTRY" --compile --target="$target" --outfile "$outfile" >/dev/null
  chmod +x "$outfile"
}

# Point bundle/kortix at the requested platform's binary so callers can
# always invoke `./bundle/kortix …` without remembering the suffix.
link_host() {
  local outfile="$1"
  ln -sf "$outfile" "$OUT_DIR/kortix"
  echo "  ↻ bundle/kortix → ${outfile}"
}
