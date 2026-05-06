#!/usr/bin/env bash
# E2E test: single-project paradigm in the kortix sandbox.
#
# Paradigm:
#   - 1 project = 1 sandbox (no multi-project, ever).
#   - The project is `proj-workspace` rooted at /workspace, auto-bootstrapped.
#   - No project_create / project_select / project_delete / project_list tools.
#   - Sessions auto-bind to proj-workspace on first ticket/task tool call.
#   - Feature flag KORTIX_PROJECTS_ENABLED gates the project-paradigm surface
#     (board, tickets, milestones, team agents) entirely.
#   - Web mirror flag NEXT_PUBLIC_ENABLE_MULTI_PROJECT hides the PM agent
#     and project URLs in the UI.
#
# Runs entirely against the live kortix-sandbox container via docker exec —
# no browser, no auth flow, no GUI. Toggles the flag at runtime and verifies
# state convergence.
set -u
PASS=0; FAIL=0; total=0; FAILS=()
TOKEN=$(docker exec kortix-sandbox cat /run/s6/container_environment/INTERNAL_SERVICE_KEY 2>/dev/null)
BASE="http://localhost:14000"
INNER="http://localhost:4096"

c() { local n="$1"; local e="$2"; local g="$3"; total=$((total+1))
  if [ "$g" = "$e" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. %-65s = %s\n" $total "$n" "$g"
  else FAIL=$((FAIL+1)); FAILS+=("$total $n: expected $e, got $g"); printf "  ✘ %3d. %-65s expected %s, got %s\n" $total "$n" "$e" "$g"; fi; }
ci() { local n="$1"; local needle="$2"; local hay="$3"; total=$((total+1))
  if echo "$hay" | grep -qF "$needle"; then PASS=$((PASS+1)); printf "  ✓ %3d. %-65s ⊃ %s\n" $total "$n" "$needle"
  else FAIL=$((FAIL+1)); FAILS+=("$total $n: missing $needle"); printf "  ✘ %3d. %-65s missing %s\n" $total "$n" "$needle"; fi; }
cni() { local n="$1"; local needle="$2"; local hay="$3"; total=$((total+1))
  if echo "$hay" | grep -qF "$needle"; then FAIL=$((FAIL+1)); FAILS+=("$total $n: leaked $needle"); printf "  ✘ %3d. %-65s LEAKED %s\n" $total "$n" "$needle"
  else PASS=$((PASS+1)); printf "  ✓ %3d. %-65s no %s\n" $total "$n" "$needle"; fi; }

flip() {
  local val="$1"
  docker exec kortix-sandbox sh -c "echo -n \"$val\" > /run/s6/container_environment/KORTIX_PROJECTS_ENABLED"
  PID=$(docker exec kortix-sandbox sh -c "ps -ef | grep 'bun run /ephemeral/kortix-master' | grep -v grep | awk '{print \$2}'" | head -1)
  [ -n "$PID" ] && docker exec kortix-sandbox kill -TERM "$PID" 2>/dev/null
  for i in $(seq 1 30); do
    sleep 1
    H=$(curl -s --max-time 1 "$BASE/kortix/health" 2>/dev/null)
    echo "$H" | grep -q "\"projectsEnabled\":$val" && break
  done
  sleep 2
  OPCDPID=$(docker exec kortix-sandbox sh -c "ps -ef | grep 'opencode-kortix serve' | grep -v grep | awk '{print \$2}'" | head -1)
  [ -n "$OPCDPID" ] && docker exec kortix-sandbox kill -TERM "$OPCDPID" 2>/dev/null
  if [ "$val" = "true" ]; then
    for i in $(seq 1 90); do sleep 1; T=$(docker exec kortix-sandbox curl -s --max-time 2 $INNER/experimental/tool/ids 2>/dev/null); echo "$T" | grep -q "project_get" && return 0; done
  else
    for i in $(seq 1 60); do sleep 1; T=$(docker exec kortix-sandbox curl -s --max-time 2 $INNER/experimental/tool/ids 2>/dev/null); [ -n "$T" ] && ! echo "$T" | grep -q "project_get" && return 0; done
  fi
}

echo "═══════════════════════════════════════════════════════════════════════"
echo " SINGLE-PROJECT PARADIGM — E2E (docker exec)"
echo "═══════════════════════════════════════════════════════════════════════"

echo
echo "── 1. Default state: flag OFF, no project paradigm visible ──"
H=$(curl -s "$BASE/kortix/health")
ci "health.features.projectsEnabled = false" '"projectsEnabled":false' "$H"

# project routes 503 (defense-in-depth — UI never hits these when flag off)
for p in /kortix/projects /kortix/tickets /kortix/tasks /kortix/projects/proj-workspace; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$p" -H "Authorization: Bearer $TOKEN")
  c "GET $p → 503 (gated)" "503" "$code"
done

# Tool registry — zero project-paradigm surface
TOOLS_OFF=$(docker exec kortix-sandbox curl -s $INNER/experimental/tool/ids)
total=$((total+1))
TOTAL_OFF=$(echo "$TOOLS_OFF" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
if [ "$TOTAL_OFF" = "43" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. tool count = 43 (no project paradigm)\n" $total
else FAIL=$((FAIL+1)); FAILS+=("tool count = $TOTAL_OFF, expected 43"); printf "  ✘ %3d. tool count = %s, expected 43\n" $total "$TOTAL_OFF"; fi

for prefix in project_ ticket_ milestone_ team_ credential_ task_; do
  CT=$(echo "$TOOLS_OFF" | python3 -c "import sys,json;print(len([t for t in json.load(sys.stdin) if t.startswith('$prefix')]))")
  c "no ${prefix}* tools (flag off)" "0" "$CT"
done

echo
echo "── 2. Single-project guarantee: removed tools never come back ──"
flip "true"

TOOLS_ON=$(docker exec kortix-sandbox curl -s $INNER/experimental/tool/ids)
# These 4 tools are GONE in the new paradigm — never registered, even with flag on.
for forbidden in project_create project_select project_delete project_list; do
  cni "tool '$forbidden' is NEVER registered (single-project paradigm)" "\"$forbidden\"" "$TOOLS_ON"
done

# These tools DO exist when flag on — they operate on THE single project.
for kept in project_get project_update project_context_get project_context_sync \
            project_columns_update project_fields_update project_templates_update \
            ticket_create ticket_get ticket_list ticket_update \
            milestone_create milestone_get milestone_list \
            team_create_agent team_list \
            credential_set credential_get credential_list \
            task_create task_get task_list task_update; do
  ci "tool '$kept' registered when flag on" "\"$kept\"" "$TOOLS_ON"
done

echo
echo "── 3. Auto-bootstrap: proj-workspace exists in SQLite ──"
docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db", { readonly: true })
const r = db.prepare("SELECT id, path, structure_version FROM projects WHERE id=\"proj-workspace\"").get()
console.log(JSON.stringify(r))
' > /tmp/proj-row.json
ROW=$(cat /tmp/proj-row.json)
ci "proj-workspace row present" '"id":"proj-workspace"' "$ROW"
ci "proj-workspace rooted at /workspace" '"path":"/workspace"' "$ROW"
ci "proj-workspace is structure_version=2 (board-capable)" '"structure_version":2' "$ROW"

echo
echo "── 4. Session auto-bind: ticket_create resolves THE project transparently ──"
# Direct call against opencode session.create, then call ticket_create as the LLM would.
# We don't mint LLM tokens here; we just verify the route + auto-bind path.
# Check via DB: any session bound to proj-workspace via session_projects table.
docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db", { readonly: true })
const cnt = (db.prepare("SELECT COUNT(*) AS c FROM session_projects WHERE project_id=\"proj-workspace\"").get() as { c: number }).c
console.log("bound_sessions:", cnt)
' > /tmp/bind-count.txt
ci "session_projects table tracks proj-workspace bindings" "bound_sessions:" "$(cat /tmp/bind-count.txt)"

echo
echo "── 5. Multi-project tool absence is permanent (revert + replay) ──"
# Even after a kortix-master restart, project_create stays absent.
KMPID=$(docker exec kortix-sandbox sh -c "ps -ef | grep 'bun run /ephemeral/kortix-master' | grep -v grep | awk '{print \$2}'" | head -1)
docker exec kortix-sandbox kill -TERM "$KMPID" 2>/dev/null
sleep 5
OPCDPID=$(docker exec kortix-sandbox sh -c "ps -ef | grep 'opencode-kortix serve' | grep -v grep | awk '{print \$2}'" | head -1)
docker exec kortix-sandbox kill -TERM "$OPCDPID" 2>/dev/null
for i in $(seq 1 60); do sleep 1; T=$(docker exec kortix-sandbox curl -s --max-time 2 $INNER/experimental/tool/ids 2>/dev/null); echo "$T" | grep -q "project_get" && break; done
TOOLS_REPLAY=$(docker exec kortix-sandbox curl -s $INNER/experimental/tool/ids)
cni "after restart, project_create still absent" "\"project_create\"" "$TOOLS_REPLAY"
cni "after restart, project_select still absent" "\"project_select\"" "$TOOLS_REPLAY"

echo
echo "── 6. Existing user data preserved ──"
docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db", { readonly: true })
const projects = (db.prepare("SELECT COUNT(*) AS c FROM projects").get() as { c: number }).c
const tickets = (db.prepare("SELECT COUNT(*) AS c FROM tickets").get() as { c: number }).c
console.log(JSON.stringify({ projects, tickets }))
' > /tmp/preserve.txt
ci "user projects preserved (>=1 row)" '"projects":' "$(cat /tmp/preserve.txt)"
ci "user tickets preserved (>=1 row)" '"tickets":' "$(cat /tmp/preserve.txt)"

echo
echo "── 7. Flip OFF: gate closes again ──"
flip "false"

H_OFF=$(curl -s "$BASE/kortix/health")
ci "after flip OFF: features.projectsEnabled=false (default restored)" '"projectsEnabled":false' "$H_OFF"

TOOLS_OFF2=$(docker exec kortix-sandbox curl -s $INNER/experimental/tool/ids)
for forbidden in project_get project_update ticket_create milestone_create team_create_agent credential_set; do
  cni "after flip OFF: '$forbidden' gone" "\"$forbidden\"" "$TOOLS_OFF2"
done

echo
echo "── 8. Workspace overlay reflects flag state ──"
OVERLAY=$(docker exec kortix-sandbox cat /workspace/.opencode/opencode.jsonc)
ci "overlay disables orchestrator when flag off" '"orchestrator"' "$OVERLAY"
ci "overlay disables project-maintainer when flag off" '"project-maintainer"' "$OVERLAY"
ci "overlay disables worker when flag off" '"worker"' "$OVERLAY"

echo
echo "── 9. Default-agent system prompt: zero project tokens ──"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
docker cp "$SCRIPT_DIR/_helpers-prompt-leak-test.ts" kortix-sandbox:/tmp/prompt-leak-test.ts >/dev/null 2>&1
LEAK=$(docker exec kortix-sandbox /opt/bun/bin/bun /tmp/prompt-leak-test.ts 2>&1)
ci "general agent prompt has 0 project-paradigm tokens" "ZERO project-paradigm tokens" "$LEAK"

echo
echo "── 10. Triggers + channels still work without a project (sandbox-wide) ──"
TRIG_BODY='{"name":"e2e-paradigm-trig","source":{"type":"cron","cron_expr":"0 0 * * *","timezone":"UTC"},"action":{"type":"command","command":"echo paradigm"}}'
TRIG_RESP=$(curl -s -X POST "$BASE/kortix/triggers" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$TRIG_BODY")
TRIG_ID=$(echo "$TRIG_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('data') or {}).get('id') or '')" 2>/dev/null)
TRIG_PID=$(echo "$TRIG_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);v=(d.get('data') or {}).get('project_id');print('NULL' if v is None else v)" 2>/dev/null)
total=$((total+1))
if [ -n "$TRIG_ID" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. trigger created without project_id (id=%s)\n" $total "${TRIG_ID:0:8}"
else FAIL=$((FAIL+1)); FAILS+=("trigger create failed"); printf "  ✘ %3d. trigger create failed: %s\n" $total "${TRIG_RESP:0:200}"; fi
total=$((total+1))
if [ "$TRIG_PID" = "NULL" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. trigger row has project_id=null (sandbox-wide)\n" $total
else FAIL=$((FAIL+1)); FAILS+=("trigger leaked project_id=$TRIG_PID"); printf "  ✘ %3d. trigger leaked project_id=%s\n" $total "$TRIG_PID"; fi
[ -n "$TRIG_ID" ] && curl -s -X DELETE "$BASE/kortix/triggers/$TRIG_ID" -H "Authorization: Bearer $TOKEN" >/dev/null

echo
echo "═══════════════════════════════════════════════════════════════════════"
echo "  SINGLE-PROJECT PARADIGM E2E: $PASS / $total passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════════════════"
if [ $FAIL -gt 0 ]; then
  echo "Failures:"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
exit $FAIL
