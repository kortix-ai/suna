#!/usr/bin/env bash
# End-to-end exercise of the ENTIRE kortix CLI against a live Kortix host.
#
# It scaffolds a throwaway project, ships it (creating a real cloud project +
# managed git repo), then drives every command group — secrets, env, providers,
# connectors, sandboxes, files, triggers, channels, cr, sessions + chat, access,
# apps — asserting each works. Finally it purges everything it created.
#
# Prereqs: logged in (`kortix login`) against a host whose account has credits.
# Usage:   bash apps/cli/scripts/e2e-cli.sh
#          KORTIX_E2E_KEEP=1 bash …   # don't purge the project at the end
set -uo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$CLI_DIR/src/index.ts"
RUN=(bun run "$CLI")

PASS=0
FAIL=0
FAILED_NAMES=()

# run <name> -- <cmd...>            assert exit 0
# run_grep <name> <pattern> -- ...  assert exit 0 AND output matches pattern
run() {
  local name="$1"; shift; [[ "$1" == "--" ]] && shift
  local out; out="$("$@" 2>&1)"; local code=$?
  if [[ $code -eq 0 ]]; then echo "  ✓ $name"; PASS=$((PASS+1));
  else echo "  ✗ $name (exit $code)"; echo "$out" | sed 's/^/      /' | tail -4; FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); fi
}
run_grep() {
  local name="$1"; local pat="$2"; shift 2; [[ "$1" == "--" ]] && shift
  local out; out="$("$@" 2>&1)"; local code=$?
  if [[ $code -eq 0 ]] && echo "$out" | grep -qE "$pat"; then echo "  ✓ $name"; PASS=$((PASS+1));
  else echo "  ✗ $name (exit $code, want /$pat/)"; echo "$out" | sed 's/^/      /' | tail -4; FAIL=$((FAIL+1)); FAILED_NAMES+=("$name"); fi
}
# run_grep_retry <name> <pattern> <tries> -- ...   for eventually-consistent
# cloud reads (managed-git mirror + connector reconcile lag right after ship).
run_grep_retry() {
  local name="$1"; local pat="$2"; local tries="$3"; shift 3; [[ "$1" == "--" ]] && shift
  local out code t
  for ((t=1; t<=tries; t++)); do
    out="$("$@" 2>&1)"; code=$?
    if [[ $code -eq 0 ]] && echo "$out" | grep -qE "$pat"; then echo "  ✓ $name (try $t)"; PASS=$((PASS+1)); return; fi
    sleep 3
  done
  echo "  ✗ $name (exit $code, want /$pat/ after $tries tries)"; echo "$out" | sed 's/^/      /' | tail -3; FAIL=$((FAIL+1)); FAILED_NAMES+=("$name")
}
section() { echo; echo "── $1 ──"; }

# ── Scratch project ─────────────────────────────────────────────────────────
WORK="$(mktemp -d -t kortix-e2e-XXXXXX)"
cleanup() {
  if [[ "${KORTIX_E2E_KEEP:-0}" != "1" ]]; then
    ( cd "$WORK" && "${RUN[@]}" projects rm --purge -y >/dev/null 2>&1 )
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT
cd "$WORK"

echo "kortix CLI e2e  ·  cwd=$WORK"

section "identity & hosts"
run_grep "whoami"        "@"                 -- "${RUN[@]}" whoami
run_grep "hosts ls"      "active"            -- "${RUN[@]}" hosts ls
run_grep "version"       "Kortix CLI"        -- "${RUN[@]}" version
run_grep "help"          "ship"              -- "${RUN[@]}" help

section "init & validate"
run_grep "init"          "Initialized"       -- "${RUN[@]}" init --name e2e-cli --primary claude --template minimal -y
run_grep "validate"      "valid"             -- "${RUN[@]}" validate

section "ship (create cloud project)"
run_grep "ship"          "Shipped"           -- "${RUN[@]}" ship -y -m "e2e: ship"
# The managed-git mirror is readable a few seconds after the first push.
run_grep_retry "repo readable (mirror)" "kortix.toml" 20 -- "${RUN[@]}" files ls

section "projects"
run_grep "projects ls"   "e2e-cli"           -- "${RUN[@]}" projects ls
run_grep "projects info" "project_id"        -- "${RUN[@]}" projects info

section "secrets & env"
run            "secrets set"                 -- "${RUN[@]}" secrets set E2E_TOKEN=abc123
run_grep "secrets ls"    "E2E_TOKEN"         -- "${RUN[@]}" secrets ls
run            "env pull"                     -- "${RUN[@]}" env pull
run            "secrets unset"                -- "${RUN[@]}" secrets unset E2E_TOKEN

section "connectors (config = local kortix.toml; auth/reads = cloud)"
run_grep "connectors add (local)" "kortix.toml" -- "${RUN[@]}" connectors add e2echk --provider http --base-url https://httpbin.org
run_grep "→ block in toml"  "slug = \"e2echk\"" -- grep -A2 'e2echk' kortix.toml
run            "connectors policy set (local)" -- "${RUN[@]}" connectors policy set --default risk
run_grep "→ [policy] in toml" "default_mode" -- cat kortix.toml
run            "ship (push config)"          -- "${RUN[@]}" ship -y -m "e2e: connectors"
# Reconcile is eventually-consistent: the server mirrors kortix.toml from git on
# a ~60s throttle, so poll sync→ls until the toml connector materializes.
run_grep_retry "connector materialized (cloud)" "e2echk" 35 -- bash -c "${RUN[*]} connectors sync >/dev/null 2>&1; ${RUN[*]} connectors ls"
run            "connectors credential (cloud)" -- bash -c "printf 'sk-x' | ${RUN[*]} connectors credential e2echk -"
run            "connectors share (cloud)"     -- "${RUN[@]}" connectors share e2echk --mode project
run            "connectors policy ls (cloud)" -- "${RUN[@]}" connectors policy ls
run_grep "connectors apps (cloud)"  "slack"  -- "${RUN[@]}" connectors apps slack
run            "connectors rm (local)"        -- "${RUN[@]}" connectors rm e2echk

section "sandboxes (templates = local kortix.toml; builds = cloud)"
run_grep "sandboxes ls (cloud)" "default"    -- "${RUN[@]}" sandboxes ls
run            "sandboxes health (cloud)"     -- "${RUN[@]}" sandboxes health
run            "sandboxes builds (cloud)"     -- "${RUN[@]}" sandboxes builds
run_grep "sandboxes add (local)" "toml"      -- "${RUN[@]}" sandboxes add e2eimg --image alpine:3 --cpu 1 --memory 1
run_grep "→ block in toml"  "slug = \"e2eimg\"" -- grep -A2 'e2eimg' kortix.toml
run            "sandboxes update (local)"     -- "${RUN[@]}" sandboxes update e2eimg --memory 2
run            "sandboxes rm (local)"         -- "${RUN[@]}" sandboxes rm e2eimg

section "files (repo browsing)"
run_grep_retry "files ls"  "kortix.toml" 10  -- "${RUN[@]}" files ls
run_grep_retry "files cat" "kortix_version" 10 -- "${RUN[@]}" files cat kortix.toml
run            "files search"                 -- "${RUN[@]}" files search kortix
run_grep_retry "files branches" "main" 5     -- "${RUN[@]}" files branches
run_grep_retry "files commits" "e2e: ship" 10 -- "${RUN[@]}" files commits

section "triggers (config = local kortix.toml)"
run_grep "triggers add (local)" "kortix.toml" -- "${RUN[@]}" triggers add e2ecron --type cron --cron "0 0 3 * * *" --prompt "daily" --agent kortix
run_grep "→ block in toml"  "slug = \"e2ecron\"" -- grep -A2 'e2ecron' kortix.toml
run            "triggers disable (local)"     -- "${RUN[@]}" triggers disable e2ecron
run            "triggers enable (local)"      -- "${RUN[@]}" triggers enable e2ecron
run            "triggers rm (local)"          -- "${RUN[@]}" triggers rm e2ecron
run            "triggers ls (cloud)"          -- "${RUN[@]}" triggers ls

section "channels"
run_grep "channels status"  "slack"          -- "${RUN[@]}" channels status

section "change requests"
run            "cr ls"                        -- "${RUN[@]}" cr ls

section "access (project members)"
run_grep "access ls"       "$(whoami >/dev/null; echo '@')" -- "${RUN[@]}" access ls
run            "access pending"               -- "${RUN[@]}" access pending

section "apps (experimental — may be gated)"
"${RUN[@]}" apps ls >/dev/null 2>&1 && echo "  ✓ apps ls (enabled)" || echo "  ⊘ apps gated (expected unless KORTIX_APPS_EXPERIMENTAL=true)"

section "sessions + chat (provisions a real sandbox)"
SID="$("${RUN[@]}" sessions new 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
if [[ -n "$SID" ]]; then
  echo "  ✓ sessions new ($SID)"; PASS=$((PASS+1))
  run_grep "sessions ls"    "$SID" -- "${RUN[@]}" sessions ls
  # wait for running, then chat
  for i in $(seq 1 30); do
    st="$("${RUN[@]}" sessions info "$SID" 2>/dev/null | grep -E '^\s*status' | awk '{print $2}')"
    [[ "$st" == "running" ]] && break; sleep 4
  done
  run_grep "chat one-shot" "assistant" -- "${RUN[@]}" chat "$SID" -p "Reply with the single word OK."
  run "sessions rm" -- "${RUN[@]}" sessions rm "$SID"
else
  echo "  ✗ sessions new (no session id)"; FAIL=$((FAIL+1)); FAILED_NAMES+=("sessions new")
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════"
echo "  PASS: $PASS    FAIL: $FAIL"
if [[ $FAIL -gt 0 ]]; then printf '  failed: %s\n' "${FAILED_NAMES[*]}"; fi
echo "════════════════════════════════════════"
exit $(( FAIL > 0 ? 1 : 0 ))
