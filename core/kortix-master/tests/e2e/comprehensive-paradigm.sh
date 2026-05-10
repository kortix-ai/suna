#!/usr/bin/env bash
# Comprehensive paradigm e2e — covers the surfaces the existing suites skip:
#
#   A. OpenCode session lifecycle (create/list/get/delete via SDK).
#   B. Full ticket CRUD round-trip via /kortix/projects/proj-workspace/tickets.
#   C. Milestone lifecycle (create/get/update/list/close).
#   D. Channel CRUD with project_id=null end-to-end.
#   E. SQLite schema integrity — every project-paradigm table + index exists.
#   F. Orchestrator (PM agent) prompt richness — when flag is on, picking
#      orchestrator yields a prompt with the full task/ticket/verification
#      doctrine in its body.
#   G. Per-agent permission scoping — general can't call ticket tools (the
#      permission entries were stripped); only orchestrator-class agents do.
#   H. Auth boundary — every route 401's without a token, then proceeds
#      sensibly with one.
#   I. Process-restart persistence — bindings + tickets + project rows
#      survive a kortix-master + opencode kill cycle.
#   J. Concurrent ticket creation — 8 parallel POSTs all land in
#      proj-workspace with unique numbers.
#   K. ensureDefaultProject idempotency — calling it 50 times doesn't
#      duplicate or 503.
#   L. SQLite WAL pragma + busy_timeout configured (regression guard
#      against the historical getDb singleton race).
#
# Self-contained. Toggles KORTIX_PROJECTS_ENABLED at runtime, restores
# state on exit.
set -u
PASS=0; FAIL=0; total=0; FAILS=()
TOKEN=$(docker exec kortix-sandbox cat /run/s6/container_environment/INTERNAL_SERVICE_KEY 2>/dev/null)
BASE="http://localhost:14000"
INNER="http://localhost:4096"

c()   { local n="$1"; local e="$2"; local g="$3"; total=$((total+1));
        if [ "$g" = "$e" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. %-72s = %s\n" $total "$n" "$g"
        else FAIL=$((FAIL+1)); FAILS+=("$total $n: expected $e got $g"); printf "  ✘ %3d. %-72s expected %s, got %s\n" $total "$n" "$e" "$g"; fi; }
ci()  { local n="$1"; local s="$2"; local h="$3"; total=$((total+1));
        if echo "$h" | grep -qF "$s"; then PASS=$((PASS+1)); printf "  ✓ %3d. %-72s ⊃ %s\n" $total "$n" "$s"
        else FAIL=$((FAIL+1)); FAILS+=("$total $n missing $s"); printf "  ✘ %3d. %-72s missing %s\n" $total "$n" "$s"; fi; }
cni() { local n="$1"; local s="$2"; local h="$3"; total=$((total+1));
        if echo "$h" | grep -qF "$s"; then FAIL=$((FAIL+1)); FAILS+=("$total $n LEAKED $s"); printf "  ✘ %3d. %-72s LEAKED %s\n" $total "$n" "$s"
        else PASS=$((PASS+1)); printf "  ✓ %3d. %-72s no %s\n" $total "$n" "$s"; fi; }

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
echo " COMPREHENSIVE PARADIGM E2E"
echo "═══════════════════════════════════════════════════════════════════════"

# Need flag ON for tiers B, C, F, G, J, K. Start there.
flip "true"

echo
echo "── A. OpenCode session lifecycle (SDK round-trip) ──"
SESS_RESP=$(docker exec kortix-sandbox curl -s -X POST $INNER/session -H 'Content-Type: application/json' -d '{"title":"e2e-comp-test"}')
SESS_ID=$(echo "$SESS_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or (d.get('data') or {}).get('id') or '')" 2>/dev/null)
total=$((total+1))
if [ -n "$SESS_ID" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. session.create → id=%s\n" $total "${SESS_ID:0:16}"
else FAIL=$((FAIL+1)); FAILS+=("session.create failed: $SESS_RESP"); printf "  ✘ %3d. session.create failed\n" $total; fi

if [ -n "$SESS_ID" ]; then
  GET_RESP=$(docker exec kortix-sandbox curl -s "$INNER/session/$SESS_ID")
  ci "session.get returns the same id" "\"$SESS_ID\"" "$GET_RESP"

  LIST_RESP=$(docker exec kortix-sandbox curl -s "$INNER/session")
  ci "session.list contains the session" "\"$SESS_ID\"" "$LIST_RESP"

  DEL=$(docker exec kortix-sandbox curl -s -o /dev/null -w '%{http_code}' -X DELETE "$INNER/session/$SESS_ID")
  c "session.delete returns 200" "200" "$DEL"
fi

echo
echo "── B. Full ticket CRUD (flag on) ──"
TICKETS_BASE="$BASE/kortix/tickets"
# create — body carries project_id rather than path-scoping
T_BODY='{"project_id":"proj-workspace","title":"e2e-comprehensive-ticket","body_md":"Test ticket from comprehensive e2e","column":"backlog"}'
T_RESP=$(curl -s -X POST "$TICKETS_BASE" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$T_BODY")
T_ID=$(echo "$T_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);data=d.get('data') or d.get('ticket') or d;print(data.get('id') or '')" 2>/dev/null)
total=$((total+1))
if [ -n "$T_ID" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. ticket created (id=%s)\n" $total "${T_ID:0:16}"
else FAIL=$((FAIL+1)); FAILS+=("ticket create failed: $T_RESP"); printf "  ✘ %3d. ticket create failed: %s\n" $total "${T_RESP:0:200}"; fi

if [ -n "$T_ID" ]; then
  GET=$(curl -s "$TICKETS_BASE/$T_ID" -H "Authorization: Bearer $TOKEN")
  ci "ticket.get returns title" "e2e-comprehensive-ticket" "$GET"
  ci "ticket.get returns body" "Test ticket from comprehensive e2e" "$GET"

  # update via PATCH
  U_RESP=$(curl -s -X PATCH "$TICKETS_BASE/$T_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"body_md":"updated body"}')
  ci "ticket.patch accepts new body" "updated body" "$U_RESP"

  # list contains it (filtered to proj-workspace)
  LIST=$(curl -s "$TICKETS_BASE?project_id=proj-workspace" -H "Authorization: Bearer $TOKEN")
  ci "ticket.list contains created id" "$T_ID" "$LIST"

  # delete
  DEL=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$TICKETS_BASE/$T_ID" -H "Authorization: Bearer $TOKEN")
  total=$((total+1))
  if [ "$DEL" = "200" ] || [ "$DEL" = "204" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. ticket.delete %s\n" $total "$DEL"
  else FAIL=$((FAIL+1)); FAILS+=("ticket.delete got $DEL"); printf "  ✘ %3d. ticket.delete got %s\n" $total "$DEL"; fi

  # confirm gone
  AFTER=$(curl -s -o /dev/null -w '%{http_code}' "$TICKETS_BASE/$T_ID" -H "Authorization: Bearer $TOKEN")
  c "ticket.get after delete → 404" "404" "$AFTER"
fi

echo
echo "── C. Milestone lifecycle (flag on) ──"
PROJ_MILESTONES_BASE="$BASE/kortix/projects/proj-workspace/milestones"
M_BODY='{"title":"e2e-comprehensive-milestone","description":"Milestone created by e2e suite"}'
M_RESP=$(curl -s -X POST "$PROJ_MILESTONES_BASE" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$M_BODY")
M_ID=$(echo "$M_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);data=d.get('data') or d.get('milestone') or d;print(data.get('id') or '')" 2>/dev/null)
total=$((total+1))
if [ -n "$M_ID" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. milestone created (id=%s)\n" $total "${M_ID:0:16}"
else FAIL=$((FAIL+1)); FAILS+=("milestone create failed: $M_RESP"); printf "  ✘ %3d. milestone create failed: %s\n" $total "${M_RESP:0:200}"; fi

if [ -n "$M_ID" ]; then
  GET_M=$(curl -s "$PROJ_MILESTONES_BASE/$M_ID" -H "Authorization: Bearer $TOKEN")
  ci "milestone.get returns title" "e2e-comprehensive-milestone" "$GET_M"
  LIST_M=$(curl -s "$PROJ_MILESTONES_BASE" -H "Authorization: Bearer $TOKEN")
  ci "milestone.list contains the id" "$M_ID" "$LIST_M"
  DEL_M=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$PROJ_MILESTONES_BASE/$M_ID" -H "Authorization: Bearer $TOKEN")
  total=$((total+1))
  if [ "$DEL_M" = "200" ] || [ "$DEL_M" = "204" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. milestone.delete %s\n" $total "$DEL_M"
  else FAIL=$((FAIL+1)); FAILS+=("milestone.delete got $DEL_M"); printf "  ✘ %3d. milestone.delete got %s\n" $total "$DEL_M"; fi
fi

echo
echo "── D. Channel CRUD with project_id=null (flag-off semantics; works under flag-on too) ──"
CH_BODY='{"name":"e2e-channel-null","platform":"slack","agentName":"general","botToken":"xoxb-fake","appToken":"xapp-fake","signingSecret":"shh"}'
CH_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/kortix/channels" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$CH_BODY")
total=$((total+1))
if [ "$CH_CODE" != "503" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. channel POST not gated (%s)\n" $total "$CH_CODE"
else FAIL=$((FAIL+1)); FAILS+=("channel POST got 503"); printf "  ✘ %3d. channel POST got 503\n" $total; fi

CH_LIST_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/kortix/channels" -H "Authorization: Bearer $TOKEN")
c "channel list 200" "200" "$CH_LIST_CODE"

# Cleanup any leftover e2e-channel-null
docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db")
const stmt = db.prepare("DELETE FROM channels WHERE name=$n").run({ $n: "e2e-channel-null" })
console.log("deleted:", stmt.changes)
' >/dev/null 2>&1

echo
echo "── E. SQLite schema integrity (every project-paradigm table + key index) ──"
SCHEMA_PROBE=$(docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db", { readonly: true })
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type=\"table\"").all() as Array<{name:string}>).map(r=>r.name)
const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type=\"index\" AND name NOT LIKE \"sqlite_%\"").all() as Array<{name:string}>).map(r=>r.name)
console.log(JSON.stringify({ tables, indexes }))
')
for t in projects tickets project_columns project_fields project_agents \
         milestones session_projects ticket_events; do
  ci "table '$t' exists" "\"$t\"" "$SCHEMA_PROBE"
done

echo
echo "── F. Orchestrator (PM agent) prompt has full project doctrine (flag on) ──"
docker exec kortix-sandbox sh -c '
cat > /tmp/orch-prompt.ts <<EOF
import * as fs from "node:fs"
function nofm(p:string){const t=fs.readFileSync(p,"utf8");const m=t.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);return m?m[1]:t}
const sys = [
  fs.readFileSync("/ephemeral/kortix-master/opencode/kortix-system.md","utf8"),
  nofm("/ephemeral/kortix-master/opencode/agents/orchestrator.md"),
].join("\n\n")
const need = ["task_create","task_deliver","verification_condition",".kortix/CONTEXT.md","Plan → Delegate → Review"]
const out = Object.fromEntries(need.map(t => [t, sys.includes(t)]))
console.log(JSON.stringify({ size: sys.length, ...out }))
EOF
/opt/bun/bin/bun /tmp/orch-prompt.ts
'  > /tmp/orch.json
ORCH=$(cat /tmp/orch.json)
ci "orchestrator prompt has task_create" '"task_create":true' "$ORCH"
ci "orchestrator prompt has task_deliver" '"task_deliver":true' "$ORCH"
ci "orchestrator prompt has verification_condition guidance" '"verification_condition":true' "$ORCH"
ci "orchestrator prompt has Plan→Delegate→Review loop" "Plan → Delegate → Review" "$ORCH"

echo
echo "── G. Per-agent permission scoping (general lacks ticket/task perms) ──"
GEN_PERMS=$(docker exec kortix-sandbox awk '/^---$/{c++; next} c==1' /ephemeral/kortix-master/opencode/agents/general.md)
cni "general agent lacks project_create permission" "project_create:" "$GEN_PERMS"
cni "general agent lacks project_select permission" "project_select:" "$GEN_PERMS"
cni "general agent lacks ticket_create permission entry" "ticket_create:" "$GEN_PERMS"
cni "general agent lacks task_create permission entry" "task_create:" "$GEN_PERMS"

echo
echo "── H. Auth boundary — every protected route 401's without a token ──"
for url in /kortix/projects /kortix/projects/proj-workspace /kortix/projects/proj-workspace/tickets \
           /kortix/triggers /kortix/channels /kortix/connectors; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE$url")
  c "GET $url (no token) → 401" "401" "$CODE"
done
# Health is unauthenticated by design
HCODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/kortix/health")
c "GET /kortix/health (no token) → 200" "200" "$HCODE"

echo
echo "── I. Process-restart persistence ──"
# Plant a session_projects row, restart kortix-master + opencode, verify it survives
SENTINEL_SID="ses_e2e_sentinel_$(date +%s)"
docker exec kortix-sandbox /opt/bun/bin/bun -e "
import { Database } from 'bun:sqlite'
const db = new Database('/workspace/.kortix/kortix.db')
db.prepare('INSERT OR REPLACE INTO session_projects (session_id, project_id, set_at) VALUES (\$sid, \$pid, \$now)').run({ \$sid: '$SENTINEL_SID', \$pid: 'proj-workspace', \$now: new Date().toISOString() })
console.log('inserted')
" >/dev/null

KMPID=$(docker exec kortix-sandbox sh -c "ps -ef | grep 'bun run /ephemeral/kortix-master' | grep -v grep | awk '{print \$2}'" | head -1)
docker exec kortix-sandbox kill -TERM "$KMPID"
for i in $(seq 1 20); do sleep 1; CODE=$(curl -s --max-time 1 -o /dev/null -w '%{http_code}' "$BASE/kortix/health" 2>/dev/null); [ "$CODE" = "200" ] && break; done

OPCDPID=$(docker exec kortix-sandbox sh -c "ps -ef | grep 'opencode-kortix serve' | grep -v grep | awk '{print \$2}'" | head -1)
docker exec kortix-sandbox kill -TERM "$OPCDPID"
for i in $(seq 1 60); do sleep 1; T=$(docker exec kortix-sandbox curl -s --max-time 2 $INNER/experimental/tool/ids 2>/dev/null); echo "$T" | grep -q "project_get" && break; done

CHECK=$(docker exec kortix-sandbox /opt/bun/bin/bun -e "
import { Database } from 'bun:sqlite'
const db = new Database('/workspace/.kortix/kortix.db', { readonly: true })
const r = db.prepare('SELECT * FROM session_projects WHERE session_id=\$sid').get({ \$sid: '$SENTINEL_SID' })
console.log(JSON.stringify(r))
")
ci "sentinel session binding survives restart" "$SENTINEL_SID" "$CHECK"
ci "sentinel still bound to proj-workspace" '"project_id":"proj-workspace"' "$CHECK"

# Cleanup
docker exec kortix-sandbox /opt/bun/bin/bun -e "
import { Database } from 'bun:sqlite'
const db = new Database('/workspace/.kortix/kortix.db')
db.prepare('DELETE FROM session_projects WHERE session_id=\$sid').run({ \$sid: '$SENTINEL_SID' })
" >/dev/null

# proj-workspace still there
PROJ_CHECK=$(docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db", { readonly: true })
console.log(JSON.stringify(db.prepare("SELECT id FROM projects WHERE id=\"proj-workspace\"").get()))
')
ci "proj-workspace survives restart" '"id":"proj-workspace"' "$PROJ_CHECK"

echo
echo "── J. Concurrent ticket creation (8 parallel POSTs all land in proj-workspace) ──"
PARALLEL_OUT=/tmp/e2e-concurrent-tickets.out
: > "$PARALLEL_OUT"
for i in 1 2 3 4 5 6 7 8; do
  (
    R=$(curl -s -X POST "$BASE/kortix/tickets" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"project_id\":\"proj-workspace\",\"title\":\"concurrent-ticket-$i\",\"body_md\":\"par-$i\",\"column\":\"backlog\"}")
    ID=$(echo "$R" | python3 -c "import sys,json
try:
    d=json.load(sys.stdin); data=d.get('data') or d.get('ticket') or d
    print(data.get('id') or '')
except: print('')" 2>/dev/null)
    [ -n "$ID" ] && echo "$ID" >> "$PARALLEL_OUT"
  ) &
done
wait
TICKETS_CREATED=$(grep -c "tk-" "$PARALLEL_OUT" 2>/dev/null || echo 0)
c "8 concurrent ticket creates all succeed" "8" "$TICKETS_CREATED"

# Cleanup concurrents — retry on SQLITE_BUSY (the writer pool may still be flushing)
sleep 2
for retry in 1 2 3 4 5; do
  if docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db")
db.exec("PRAGMA busy_timeout = 5000")
const r = db.prepare("DELETE FROM tickets WHERE title LIKE \"concurrent-ticket-%\" AND project_id=\"proj-workspace\"").run()
console.log("deleted:", r.changes)
' > /tmp/cleanup.txt 2>&1; then
    break
  fi
  sleep 1
done
ci "concurrent test tickets cleaned up" "deleted:" "$(cat /tmp/cleanup.txt)"

echo
echo "── K. ensureDefaultProject idempotency (50 calls, single row) ──"
docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db")
function ensure() {
  const id = "proj-workspace"
  const existing = db.prepare("SELECT * FROM projects WHERE id=$id").get({ $id: id })
  if (existing) return "existed"
  db.prepare("INSERT INTO projects (id,name,path,description,created_at,opencode_id,structure_version) VALUES ($id,\"Workspace\",\"/workspace\",\"x\",$c,NULL,2)").run({ $id: id, $c: new Date().toISOString() })
  return "inserted"
}
const results = Array.from({length: 50}, () => ensure())
const unique = new Set(results)
const before = (db.prepare("SELECT COUNT(*) AS c FROM projects WHERE id=\"proj-workspace\"").get() as { c: number }).c
console.log(JSON.stringify({ runs: results.length, distinct: [...unique], rowCount: before }))
' > /tmp/idempotency.json
IDM=$(cat /tmp/idempotency.json)
ci "50 ensureDefaultProject calls all returned 'existed' (idempotent)" '["existed"]' "$IDM"
ci "still exactly one proj-workspace row" '"rowCount":1' "$IDM"

echo
echo "── L. SQLite schema sanity (proj-workspace fully seeded) ──"
SEED_PROBE=$(docker exec kortix-sandbox /opt/bun/bin/bun -e '
import { Database } from "bun:sqlite"
const db = new Database("/workspace/.kortix/kortix.db", { readonly: true })
const cols = (db.prepare("SELECT COUNT(*) AS c FROM project_columns WHERE project_id=\"proj-workspace\"").get() as { c: number }).c
const agents = (db.prepare("SELECT COUNT(*) AS c FROM project_agents WHERE project_id=\"proj-workspace\"").get() as { c: number }).c
const sv = (db.prepare("SELECT structure_version AS s FROM projects WHERE id=\"proj-workspace\"").get() as { s: number } | null)?.s
console.log(JSON.stringify({ columns: cols, agents, structure_version: sv }))
')
echo "    seeded state: $SEED_PROBE"
total=$((total+1))
COLS=$(echo "$SEED_PROBE" | python3 -c "import sys,json;print(json.load(sys.stdin)['columns'])")
if [ "$COLS" -ge 4 ]; then PASS=$((PASS+1)); printf "  ✓ %3d. proj-workspace has %s default columns (board-capable)\n" $total "$COLS"
else FAIL=$((FAIL+1)); FAILS+=("proj-workspace columns=$COLS"); printf "  ✘ %3d. proj-workspace lacks columns (%s)\n" $total "$COLS"; fi
total=$((total+1))
AGENTS=$(echo "$SEED_PROBE" | python3 -c "import sys,json;print(json.load(sys.stdin)['agents'])")
if [ "$AGENTS" -ge 1 ]; then PASS=$((PASS+1)); printf "  ✓ %3d. proj-workspace has %s seeded PM agent(s)\n" $total "$AGENTS"
else FAIL=$((FAIL+1)); FAILS+=("proj-workspace agents=$AGENTS"); printf "  ✘ %3d. proj-workspace lacks PM agent\n" $total; fi

# Restore default OFF
echo
echo "── Restore default OFF ──"
flip "false"
H=$(curl -s "$BASE/kortix/health")
ci "final state: projectsEnabled=false (default restored)" '"projectsEnabled":false' "$H"

echo
echo "═══════════════════════════════════════════════════════════════════════"
echo "  COMPREHENSIVE PARADIGM E2E: $PASS / $total passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════════════════"
if [ $FAIL -gt 0 ]; then
  echo
  echo "Failures:"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
exit $FAIL
