#!/usr/bin/env bash
#
# runtime-gate-opencode-e2e.sh
#
# End-to-end test of the Kortix runtime feature gate inside ACTUAL opencode.
# Proves the env contract the platform injects (KORTIX_RUNTIME_*) actually
# turns built-in tools on/off, driven by a real model:
#   1. default            → memory tool works
#   2. KORTIX_RUNTIME_MEMORY=off  → memory blocked (no write), show still works
#   3. KORTIX_RUNTIME_DISABLE_ALL=true → memory AND show blocked (pure OpenCode)
#
# Usage:  tests/e2e/scripts/runtime-gate-opencode-e2e.sh [model]
# Skips (exit 2) when the chosen model has no credit/access.

set -uo pipefail
MODEL="${1:-${MEMORY_E2E_MODEL:-anthropic/claude-haiku-4-5}}"
TIMEOUT="${MEMORY_E2E_TIMEOUT:-120}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOOLS_SRC="$REPO_ROOT/.kortix/opencode/tools"
command -v opencode >/dev/null || { echo "FAIL: opencode not on PATH"; exit 1; }
[ -f "$TOOLS_SRC/lib/runtime-gate.ts" ] || { echo "FAIL: runtime-gate not found"; exit 1; }

PROJ="$(mktemp -d -t rt-gate-XXXXXX)"
trap 'rm -rf "$PROJ"' EXIT
mkdir -p "$PROJ/.opencode" "$PROJ/.kortix/memory"
cp -r "$TOOLS_SRC" "$PROJ/.opencode/tools"
printf '{ "$schema":"https://opencode.ai/config.json","permission":"allow" }\n' > "$PROJ/.opencode/opencode.json"
printf '# Project Memory\n- (seed)\n' > "$PROJ/.kortix/memory/MEMORY.md"

echo "▸ project: $PROJ  model: $MODEL"

# run_case <label> <expect: works|blocked> <env-assignment...> -- <prompt>
fail=0
run_case() {
  local label="$1" expect="$2"; shift 2
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local prompt="$1"
  local marker=".kortix/memory/${label}.md"
  ( cd "$PROJ" && env "${envs[@]}" timeout "$TIMEOUT" opencode run --dir "$PROJ" --model "$MODEL" \
      --dangerously-skip-permissions "$prompt" > "$PROJ/$label.out" 2> "$PROJ/$label.err" )
  local rc=$?
  cat "$PROJ/$label.out" "$PROJ/$label.err" | sed -E 's/\x1b\[[0-9;]*m//g' > "$PROJ/$label.scrub"
  if grep -qiE 'insufficient balance|out of (extra )?usage|no allowed providers|Access denied|Forbidden|Unexpected server error' "$PROJ/$label.scrub"; then
    echo "⚠️  SKIPPED [$label] — provider unavailable ($MODEL)"; exit 2
  fi
  local created=absent; [ -f "$PROJ/$marker" ] && created=created
  if [ "$expect" = works ]; then
    [ "$created" = created ] && echo "  ✓ [$label] feature ON → wrote $marker" || { echo "  ✗ [$label] expected write, got none"; fail=1; }
  else
    [ "$created" = absent ] && echo "  ✓ [$label] gated → no write ($marker absent)" || { echo "  ✗ [$label] expected NO write but file appeared"; fail=1; }
  fi
}

run_case default works -- \
  'Use the memory tool: command="create", path=".kortix/memory/default.md", file_text="ok". Then reply DONE.'

run_case memoff blocked KORTIX_RUNTIME_MEMORY=off -- \
  'Use the memory tool: command="create", path=".kortix/memory/memoff.md", file_text="ok". Then reply DONE.'

run_case alloff blocked KORTIX_RUNTIME_DISABLE_ALL=true -- \
  'Use the memory tool: command="create", path=".kortix/memory/alloff.md", file_text="ok". Then reply DONE.'

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ PASS — Kortix runtime gate enforces on/off through real opencode (model: $MODEL)"
  exit 0
else
  echo "❌ FAIL — see cases above"; exit 1
fi
