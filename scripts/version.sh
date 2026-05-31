#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix unified version helper                                                ║
# ║                                                                              ║
# ║  The root ./VERSION file is the single source of truth for the API, web,     ║
# ║  CLI, and desktop. This script prints the version string the CI pipelines    ║
# ║  stamp onto build artifacts.                                                  ║
# ║                                                                              ║
# ║    scripts/version.sh            → X.Y.Z                (clean/promoted)      ║
# ║    scripts/version.sh --clean    → X.Y.Z                (alias for default)  ║
# ║    scripts/version.sh --dev      → X.Y.Z-dev.<sha8>     (dev build)          ║
# ║    DEV=1 scripts/version.sh      → X.Y.Z-dev.<sha8>     (dev build via env)  ║
# ║    scripts/version.sh --tag      → vX.Y.Z               (git tag form)       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

# Resolve the repo root relative to this script so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION_FILE="$ROOT_DIR/VERSION"

[ -f "$VERSION_FILE" ] || { echo "VERSION file not found at $VERSION_FILE" >&2; exit 1; }

# Read the clean semantic version (strip whitespace/newline).
CLEAN="$(tr -d '[:space:]' < "$VERSION_FILE")"
[ -n "$CLEAN" ] || { echo "VERSION file is empty" >&2; exit 1; }

# Short commit SHA: prefer the CI-provided GITHUB_SHA, else ask git.
short_sha() {
  local sha="${GITHUB_SHA:-}"
  if [ -z "$sha" ]; then
    sha="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo "")"
  fi
  # Truncate to 8 chars (empty stays empty → "unknown" fallback).
  if [ -n "$sha" ]; then
    printf '%s' "${sha:0:8}"
  else
    printf '%s' "unknown"
  fi
}

MODE="clean"
case "${1:-}" in
  --dev)        MODE="dev" ;;
  --clean|"")   MODE="clean" ;;
  --tag)        MODE="tag" ;;
  *)            echo "Unknown argument: $1 (use --dev, --clean, or --tag)" >&2; exit 1 ;;
esac

# Env override: DEV=1 forces dev mode.
if [ "${DEV:-}" = "1" ]; then
  MODE="dev"
fi

case "$MODE" in
  dev)   printf '%s-dev.%s\n' "$CLEAN" "$(short_sha)" ;;
  tag)   printf 'v%s\n' "$CLEAN" ;;
  clean) printf '%s\n' "$CLEAN" ;;
esac
