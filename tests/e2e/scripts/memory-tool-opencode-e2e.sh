#!/usr/bin/env bash
#
# memory-tool-opencode-e2e.sh
#
# Full end-to-end test of the `memory` tool (.kortix/opencode/tools/memory.ts)
# running inside ACTUAL opencode — loaded the real way via a project-local
# `.opencode/` config, driven by a real model, asserting on the tool-call log
# AND the real files the tool wrote under `.kortix/memory/`.
#
# Usage:   tests/e2e/scripts/memory-tool-opencode-e2e.sh [model]
#   model: provider/model (default: $MEMORY_E2E_MODEL or anthropic/claude-haiku-4-5)
#
# Requires opencode on PATH + a provider with available credit
# (`opencode providers list`). If the chosen model has no credit, the script
# reports SKIPPED (exit 2) rather than a false failure.
#
# Note: we use opencode's DEFAULT output format on purpose — `--format json`
# buffers and does not exit in headless `run`, so it would hang.

set -uo pipefail

MODEL="${1:-${MEMORY_E2E_MODEL:-anthropic/claude-haiku-4-5}}"
TIMEOUT="${MEMORY_E2E_TIMEOUT:-120}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOOL_SRC="$REPO_ROOT/.kortix/opencode/tools/memory.ts"

command -v opencode >/dev/null || { echo "FAIL: opencode not on PATH"; exit 1; }
[ -f "$TOOL_SRC" ] || { echo "FAIL: tool not found at $TOOL_SRC"; exit 1; }

PROJ="$(mktemp -d -t mem-e2e-XXXXXX)"
OUT="$PROJ/stdout.txt"; ERR="$PROJ/stderr.txt"
cleanup() { rm -rf "$PROJ"; }
trap cleanup EXIT

echo "▸ test project: $PROJ"
echo "▸ model:        $MODEL   (timeout ${TIMEOUT}s)"

# ── Lay out a project that loads the memory tool via .opencode/ ──────────────
mkdir -p "$PROJ/.opencode/tools" "$PROJ/.kortix/memory"
cp "$TOOL_SRC" "$PROJ/.opencode/tools/memory.ts"
printf '{ "$schema": "https://opencode.ai/config.json", "permission": "allow" }\n' \
  > "$PROJ/.opencode/opencode.json"
printf '# Project Memory\n- (e2e seed)\n' > "$PROJ/.kortix/memory/MEMORY.md"

E2E_FILE="$PROJ/.kortix/memory/e2e.md"

# ── Drive real opencode headlessly with an explicit, forcing prompt ──────────
read -r -d '' PROMPT <<'PROMPT' || true
Use ONLY the `memory` tool (never write/edit/read/bash). Call it exactly three
times, in this order, then stop:
1) command="create", path=".kortix/memory/e2e.md", file_text="alpha\nbeta\ngamma\n"
2) command="str_replace", path=".kortix/memory/e2e.md", old_str="beta", new_str="BETA"
3) command="view", path=".kortix/memory/e2e.md"
Then reply with exactly: DONE
PROMPT

echo "▸ running opencode (real model in the loop)…"
timeout "$TIMEOUT" opencode run \
  --dir "$PROJ" \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  "$PROMPT" > "$OUT" 2> "$ERR"
RC=$?
echo "▸ opencode exit code: $RC"

# Strip ANSI for grepping the formatted tool-call log.
SCRUB="$PROJ/scrub.txt"
cat "$OUT" "$ERR" | sed -E 's/\x1b\[[0-9;]*m//g' > "$SCRUB"

# ── Provider-credit / access guard → SKIP, not FAIL ──────────────────────────
if grep -qiE 'insufficient balance|out of (extra )?usage|out of credit|no allowed providers|Access denied|Forbidden' "$SCRUB"; then
  echo "⚠️  SKIPPED — provider '$MODEL' has no available credit/access in this env:"
  grep -iE 'insufficient balance|out of (extra )?usage|out of credit|no allowed providers|Access denied|Forbidden' "$SCRUB" | head -1 | sed 's/^/    /'
  echo "    Re-run with a funded model, e.g.: $0 openrouter/openai/gpt-4o-mini"
  exit 2
fi
if [ "$RC" -eq 124 ]; then
  echo "❌ FAIL — opencode timed out after ${TIMEOUT}s"; tail -n 15 "$SCRUB"; exit 1
fi

# ── Assertions ───────────────────────────────────────────────────────────────
fail=0
check() { if [ "$2" -eq 0 ]; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=1; fi; }

# 1) opencode ran clean.
check "opencode run exited 0" "$RC"

# 2) The memory tool actually fired (formatted log shows `memory {...}` calls).
grep -qE 'memory[[:space:]]*\{.*"command"' "$SCRUB"; check "memory tool invoked (tool-call log)" "$?"
CMDS="$(grep -oE '"command":"(view|create|str_replace|insert|delete|rename)"' "$SCRUB" | sed -E 's/.*:"//;s/"//' | sort -u | paste -sd, -)"
echo "    commands observed: ${CMDS:-(none)}"
echo "$CMDS" | grep -q create;      check "  · create called" "$?"
echo "$CMDS" | grep -q str_replace; check "  · str_replace called" "$?"

# 3) create executed: real file on disk.
[ -f "$E2E_FILE" ]; check "create → .kortix/memory/e2e.md exists on disk" "$?"

# 4) str_replace executed: replacement applied, siblings intact, old line gone.
if [ -f "$E2E_FILE" ]; then
  grep -q "BETA" "$E2E_FILE";                                   check "str_replace → contains 'BETA'" "$?"
  ( grep -q "alpha" "$E2E_FILE" && grep -q "gamma" "$E2E_FILE" ); check "str_replace → 'alpha'/'gamma' preserved" "$?"
  ( ! grep -qx "beta" "$E2E_FILE" );                            check "str_replace → old 'beta' line gone" "$?"
fi

# 5) File-based & CR-ready: a real working-tree file under .kortix/memory.
[ -f "$E2E_FILE" ]; check "write is a real file under .kortix/memory (CR-ready)" "$?"

# 6) Assistant completed the turn.
grep -q "DONE" "$SCRUB"; check "assistant finished (said DONE)" "$?"

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ PASS — memory tool works end-to-end inside real opencode (model: $MODEL)"
  exit 0
else
  echo "❌ FAIL — scrubbed transcript tail:"; tail -n 25 "$SCRUB"; exit 1
fi
