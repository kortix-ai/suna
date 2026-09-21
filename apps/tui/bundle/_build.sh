#!/usr/bin/env bash
#
# Shared builder for the standalone `kortix-tui` binaries. Per-platform scripts
# (bundle-darwin-arm64.sh etc.) source this file and call
# `build_target <bun-target> <outfile>`.
#
# Mirrors apps/cli/bundle/_build.sh on purpose: the TUI ships as its OWN
# release asset because @opentui/core dlopen's an ~18 MB native library per
# platform and pulls React in with it. Bundling that into `kortix` cost every
# user 18–37 MB for a command most never run, so `kortix tui` downloads this
# binary on first use instead (apps/cli/src/tui-bin.ts).
#
# Don't run this directly.

set -euo pipefail

# Resolve apps/tui/ regardless of where the caller lives.
TUI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="${TUI_ROOT}/src/index.tsx"
OUT_DIR="${TUI_ROOT}/bundle"

build_target() {
  local target="$1"
  local outfile="$OUT_DIR/$2"
  echo "  ↻ ${target}  →  bundle/$2"
  # OPENTUI_LIBC is baked so a glibc Linux build drops the `-musl` platform
  # package (and vice versa): @opentui/core picks the native library with
  # `process.env.OPENTUI_LIBC === "musl"` (platform/runtime-assets.bun.ts), and
  # a literal makes that branch statically dead for the bundler.
  local libc="glibc"
  case "$2" in
    *-musl) libc="musl" ;;
  esac
  bun build "$ENTRY" \
    --compile \
    --target="$target" \
    --define="process.env.OPENTUI_LIBC=\"${libc}\"" \
    --outfile "$outfile" >/dev/null
  chmod +x "$outfile"
}

# Point bundle/kortix-tui at the requested platform's binary so callers can
# always invoke `./bundle/kortix-tui …` without remembering the suffix.
link_host() {
  local outfile="$1"
  ln -sf "$outfile" "$OUT_DIR/kortix-tui"
  echo "  ↻ bundle/kortix-tui → ${outfile}"
}
