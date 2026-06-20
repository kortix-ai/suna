#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

if [ -n "${BUN_COMPILE_TARGET:-}" ]; then
  target="$BUN_COMPILE_TARGET"
else
  # Default to bun-linux-x64. Daytona's standard runners are x86_64 and the
  # snapshot builder COPYs this binary verbatim into the per-project image —
  # using the host architecture (e.g. arm64 on Apple Silicon dev machines)
  # ships an ELF the sandbox runner can't execute, the daemon never binds
  # port 8000, and every proxied request 502s. Override with
  # BUN_COMPILE_TARGET if you genuinely need a different arch (e.g. local
  # docker on Apple Silicon).
  target="bun-linux-x64"
fi

case "$target" in
  bun-linux-x64|bun-linux-arm64) ;;
  *)
    echo "Unsupported Bun compile target: $target" >&2
    exit 1
    ;;
esac

# Typecheck BEFORE the bundler runs. `bun build --compile` is a bundler — it
# does NOT typecheck, so a name referenced but never declared (e.g. a variable
# dropped during a merge while its use survived) compiles cleanly into a binary
# that throws ReferenceError at runtime. That exact class shipped a daemon that
# crashed on every warm-pool claim (cloneAtPark, 2026-06-19) → port 8000 never
# rebound → every proxied request 502'd → sandboxes stuck at "Starting the
# agent" forever. Gate the compile on a clean tsc so it can never recur.
echo "Typechecking (tsc --noEmit) before compile…"
bun run typecheck

bun build --compile --target="$target" --outfile=dist/kortix-agent src/main.ts
chmod +x dist/kortix-agent
size="$(stat -f%z dist/kortix-agent 2>/dev/null || stat -c%s dist/kortix-agent)"
echo "Built dist/kortix-agent for ${target} (${size} bytes)"
