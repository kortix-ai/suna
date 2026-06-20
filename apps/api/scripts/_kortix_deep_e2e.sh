#!/usr/bin/env bash
# DEEP e2e of the REAL Kortix runtime (default template = opencode + agent + suna stack) on PROD
# Platinum. N sequential rounds: create session(provider=platinum) -> active -> runtimeReady ->
# opencode -> send a UNIQUE compute prompt the LLM must solve -> verify the computed answer ->
# cleanup. Then a concurrency burst + warm-fork proof from host-agent logs.
set -uo pipefail
cd /Users/vukasinkubet/dev/comp/apps/api
PID="${PID:-9ebbfc1f-8c57-4882-be8d-db3058c5e7a1}"
BASE=http://localhost:8008
PK=$(grep '^PLATINUM_API_KEY=' .env.local|head -1|cut -d= -f2-)
PURL=$(grep '^PLATINUM_API_URL=' .env.local|head -1|cut -d= -f2-); PURL="${PURL:-https://api.platinum.dev}"
K=~/.ssh/platinum_prod_ed25519
ROUNDS="${ROUNDS:-5}"
psql(){ docker exec supabase_db_kortix-local psql -U postgres -tA -c "$1" 2>/dev/null; }
nowms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
mint(){ MINT_EMAIL='vukasinkubet@gmail.com' bun run scripts/_mint_jwt.ts >/dev/null 2>&1; JWT=$(cat /tmp/userjwt 2>/dev/null); H=(-H "Authorization: Bearer $JWT" -H 'Content-Type: application/json'); }
ocid(){ curl -s -m10 "${H[@]}" "$BASE/v1/p/$1/8000/session?directory=%2Fworkspace" | python3 -c "import sys,json
try:
 d=json.load(sys.stdin); ss=d if isinstance(d,list) else d.get('sessions',d.get('data',[]))
 print(ss[0]['id'] if ss else '')
except: print('')" 2>/dev/null; }

mint; [ -z "$JWT" ] && { echo "FATAL: no JWT (local supabase down?)"; exit 1; }
echo "=== DEEP REAL-KORTIX e2e on Platinum — $ROUNDS rounds (DEFAULT template: opencode+agent) ==="
pass=0; agentok=0
for r in $(seq 1 "$ROUNDS"); do
  t0=$(nowms)
  sid=$(curl -s -m20 "${H[@]}" -X POST "$BASE/v1/projects/$PID/sessions" -d '{"provider":"platinum","branch_already_created":false}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
  [ -z "$sid" ] && { echo "round $r: CREATE_FAILED"; mint; continue; }
  ext=""; while :; do row=$(psql "select external_id||'|'||status from kortix.session_sandboxes where session_id='$sid' order by created_at desc limit 1;"); ext=${row%%|*}; [ "${row##*|}" = active ] && [ -n "$ext" ] && break; [ $(( ($(nowms)-t0)/1000 )) -ge 180 ] && break; sleep 0.3; done
  [ -z "$ext" ] && { echo "round $r: NO_SANDBOX"; psql "delete from kortix.session_sandboxes where session_id='$sid';">/dev/null 2>&1; mint; continue; }
  ta=$(( $(nowms)-t0 ))
  rok=0; while :; do curl -s -m5 "${H[@]}" "$BASE/v1/p/$ext/8000/kortix/health" 2>/dev/null | grep -q '"runtimeReady":true' && { rok=1; break; }; [ $(( ($(nowms)-t0)/1000 )) -ge 180 ] && break; sleep 0.3; done
  tr=$(( $(nowms)-t0 ))
  curl -s -m30 "${H[@]}" -X POST "$BASE/v1/projects/$PID/sessions/$sid/ensure-opencode" -d '{}' >/dev/null 2>&1
  oc=$(ocid "$ext"); to=$(( $(nowms)-t0 ))
  a=$((13+r)); b=$((17+r*2)); exp=$((a*b)); agent="TIMEOUT"
  if [ -n "$oc" ]; then
    Q="What is $a multiplied by $b? Reply with only the number, nothing else."
    curl -s -m20 "${H[@]}" -X POST "$BASE/v1/p/$ext/8000/session/$oc/prompt_async?directory=%2Fworkspace" -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$Q\"}]}" -o /dev/null 2>/dev/null
    tp=$(nowms)
    while [ $(( ($(nowms)-tp)/1000 )) -lt 90 ]; do
      msgs=$(curl -s -m10 "${H[@]}" "$BASE/v1/p/$ext/8000/session/$oc/message?directory=%2Fworkspace")
      echo "$msgs" | grep -q '"role":"assistant"' && echo "$msgs" | grep -qE "\\b$exp\\b" && { agent="$exp"; break; }
      sleep 1.5
    done
  fi
  tg=$(( $(nowms)-t0 ))
  [ "$rok" = 1 ] && pass=$((pass+1))
  if [ "$agent" = "$exp" ]; then agentok=$((agentok+1)); v="PASS ${a}x${b}=${exp}"; else v="AGENT_FAIL(oc=${oc:+y}${oc:-n} ans=$agent)"; fi
  echo "round $r: $v | active+${ta}ms ready+${tr}ms opencode+${to}ms agent+${tg}ms sbx=$ext"
  curl -s -m15 -X DELETE "$PURL/v1/sandboxes/$ext" -H "Authorization: Bearer $PK" >/dev/null 2>&1
  psql "delete from kortix.session_sandboxes where session_id='$sid';" >/dev/null 2>&1
  mint
done
echo "=== SEQUENTIAL: runtimeReady $pass/$ROUNDS | agent-computed-correct $agentok/$ROUNDS ==="

echo "=== CONCURRENCY burst: 4 simultaneous real-kortix sessions ==="
mint; declare -a CSID CEXT; tb=$(nowms)
for j in 1 2 3 4; do CSID[$j]=$(curl -s -m20 "${H[@]}" -X POST "$BASE/v1/projects/$PID/sessions" -d '{"provider":"platinum","branch_already_created":false}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null); done
echo "  created sessions: ${CSID[*]}"
okc=0
for j in 1 2 3 4; do
  sid=${CSID[$j]:-}; [ -z "$sid" ] && continue
  ext=""; while :; do row=$(psql "select external_id||'|'||status from kortix.session_sandboxes where session_id='$sid' order by created_at desc limit 1;"); ext=${row%%|*}; [ "${row##*|}" = active ] && [ -n "$ext" ] && break; [ $(( ($(nowms)-tb)/1000 )) -ge 220 ] && break; sleep 0.4; done
  CEXT[$j]=$ext
  if [ -n "$ext" ]; then rr=0; while :; do curl -s -m5 "${H[@]}" "$BASE/v1/p/$ext/8000/kortix/health" 2>/dev/null|grep -q '"runtimeReady":true' && { rr=1; break; }; [ $(( ($(nowms)-tb)/1000 )) -ge 220 ] && break; sleep 0.4; done; [ "$rr" = 1 ] && okc=$((okc+1)); echo "  session $j: ext=$ext ready=$rr +$(( $(nowms)-tb ))ms"; fi
done
echo "  CONCURRENCY: $okc/4 reached runtimeReady"
for j in 1 2 3 4; do [ -n "${CEXT[$j]:-}" ] && curl -s -m15 -X DELETE "$PURL/v1/sandboxes/${CEXT[$j]}" -H "Authorization: Bearer $PK" >/dev/null 2>&1; [ -n "${CSID[$j]:-}" ] && psql "delete from kortix.session_sandboxes where session_id='${CSID[$j]}';">/dev/null 2>&1; done

echo "=== warm-fork proof: host-agent restore vs cold-boot for these spawns ==="
ssh -i "$K" -o StrictHostKeyChecking=no -o ConnectTimeout=15 -o BatchMode=yes ubuntu@51.158.248.121 \
  'sudo journalctl -u platinum-host-agent --since "14 min ago" --no-pager 2>/dev/null | grep -iE "restoreClone|via=restore|cold.?boot|restore_clone" | tail -12 | sed "s/^.*]: /  /"'
echo DONE
