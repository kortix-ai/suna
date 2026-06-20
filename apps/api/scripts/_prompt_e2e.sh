#!/usr/bin/env bash
# REAL kortix agent e2e on prod: create session -> runtimeReady -> ensure-opencode
# -> send a prompt the LLM must COMPUTE (answer not in the prompt) -> verify reply.
set -uo pipefail
cd "$(dirname "$0")/.."   # apps/api
DIR=$(pwd)
PID="${PID:-9ebbfc1f-8c57-4882-be8d-db3058c5e7a1}"
BASE=http://localhost:8008
psql(){ docker exec supabase_db_kortix-local psql -U postgres -tA -c "$1" 2>/dev/null; }
nowms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
MINT_EMAIL='vukasinkubet@gmail.com' bun run scripts/_mint_jwt.ts >/dev/null 2>&1
JWT=$(cat /tmp/userjwt); H=(-H "Authorization: Bearer $JWT" -H 'Content-Type: application/json')
t0=$(nowms)

sid=$(curl -s -m20 "${H[@]}" -X POST "$BASE/v1/projects/$PID/sessions" -d '{"branch_already_created":false}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
[ -z "$sid" ] && { echo "CREATE_FAILED"; exit 1; }
echo "session=$sid +$(( $(nowms)-t0 ))ms"

# resolve sandbox external_id (active)
ext=""; while :; do row=$(psql "select external_id||'|'||status from kortix.session_sandboxes where session_id='$sid';"); ext=${row%%|*}; [ "${row##*|}" = active ] && [ -n "$ext" ] && break; [ $(( ($(nowms)-t0)/1000 )) -ge 200 ] && break; sleep 0.3; done
echo "sandbox=$ext +$(( $(nowms)-t0 ))ms"
[ -z "$ext" ] && { echo "NO_SANDBOX"; exit 1; }

# runtimeReady
while :; do echo "$(curl -s -m5 "${H[@]}" "$BASE/v1/p/$ext/8000/kortix/health")" | grep -q '"runtimeReady":true' && break; [ $(( ($(nowms)-t0)/1000 )) -ge 200 ] && { echo "NOT_READY"; exit 2; }; sleep 0.3; done
echo "runtimeReady +$(( $(nowms)-t0 ))ms"

# ensure-opencode (best-effort: pins root + tracks in comp), then get the id from opencode directly
ens=$(curl -s -m30 "${H[@]}" -X POST "$BASE/v1/projects/$PID/sessions/$sid/ensure-opencode" -d '{}')
echo "  ensure-opencode raw: $(echo "$ens" | head -c 200)"
oc=$(curl -s -m10 "${H[@]}" "$BASE/v1/p/$ext/8000/session?directory=%2Fworkspace" | python3 -c "
import sys,json
try:
 d=json.load(sys.stdin); ss=d if isinstance(d,list) else d.get('sessions',d.get('data',[]))
 print(ss[0]['id'] if ss else '')
except Exception as e: print('')")
echo "opencode_session=$oc +$(( $(nowms)-t0 ))ms"
[ -z "$oc" ] && { echo "NO_OPENCODE_SESSION"; exit 2; }

# send a prompt the model must COMPUTE (answer 42 is NOT in the prompt)
Q="What is 6 multiplied by 7? Reply with only the number, nothing else."
pr=$(curl -s -m20 "${H[@]}" -X POST "$BASE/v1/p/$ext/8000/session/$oc/prompt_async?directory=%2Fworkspace" -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$Q\"}]}" -o /dev/null -w "%{http_code}")
echo "prompt_async -> $pr +$(( $(nowms)-t0 ))ms"

# poll messages for the assistant's computed answer (42), not present in the prompt
ans=""; tp=$(nowms)
while [ $(( ($(nowms)-tp)/1000 )) -lt 90 ]; do
  msgs=$(curl -s -m10 "${H[@]}" "$BASE/v1/p/$ext/8000/session/$oc/message?directory=%2Fworkspace")
  echo "$msgs" | grep -q '"role":"assistant"' && echo "$msgs" | grep -qE '\b42\b' && { ans=42; break; }
  sleep 1.5
done
echo "agent-replied=${ans:-TIMEOUT} +$(( $(nowms)-t0 ))ms"
if [ "$ans" = 42 ]; then echo "AGENT_E2E_PASS (LLM computed 6*7=42)"; else echo "AGENT_E2E_FAIL"; echo "  last msgs: $(echo "$msgs" | head -c 300)"; fi

# cleanup
PK=$(grep '^PLATINUM_API_KEY=' "$DIR/.env.local" | head -1 | cut -d= -f2-)
curl -s -m15 -X DELETE "https://api.platinum.dev/v1/sandboxes/$ext" -H "Authorization: Bearer $PK" >/dev/null 2>&1
psql "delete from kortix.session_sandboxes where session_id='$sid';" >/dev/null 2>&1
echo "cleaned $ext"
[ "$ans" = 42 ] && exit 0 || exit 3
