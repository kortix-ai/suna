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

compile_with_retry() {
  local attempt=1
  local max_attempts=4
  local delay=5

  while true; do
    if bun build --compile --target="$target" --outfile=dist/kortix-agent src/main.ts; then
      return 0
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "bun build --compile failed after ${max_attempts} attempts" >&2
      return 1
    fi

    echo "bun build --compile failed on attempt ${attempt}/${max_attempts}; retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# Typecheck BEFORE the bundler runs. `bun build --compile` is a bundler — it
# does NOT typecheck, so a name referenced but never declared (e.g. a variable
# dropped during a merge while its use survived) compiles cleanly into a binary
# that throws ReferenceError at runtime. That exact class once shipped a daemon
# that crashed during restored-snapshot startup (2026-06-19) → port
# 8000 never rebound → every proxied request 502'd → sandboxes stuck at
# "Starting the agent" forever. Gate the compile on a clean tsc so it can never
# recur.
# tsconfig.build.json excludes *.test.ts. The isolated Docker build copies only
# this app (no monorepo), so the two workspace-package integration tests
# (harness-registry.conformance / sdk-bridge.e2e — they import @kortix/shared and
# @kortix/sdk) can't resolve here; they are typechecked in the monorepo via the
# default tsconfig.json. The compiled binary only ever bundles src/main.ts's
# graph, which never reaches a test file.
echo "Typechecking (tsc --noEmit) before compile…"
bun tsc --noEmit -p tsconfig.build.json

compile_with_retry
chmod +x dist/kortix-agent
size="$(stat -f%z dist/kortix-agent 2>/dev/null || stat -c%s dist/kortix-agent)"
echo "Built dist/kortix-agent for ${target} (${size} bytes)"
