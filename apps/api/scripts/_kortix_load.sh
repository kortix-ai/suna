#!/usr/bin/env bash
# MAX kortix load test — ramp concurrent agent sessions through the REAL kortix flow
# (comp session -> active -> runtimeReady -> opencode -> a compute prompt the LLM must
# solve -> verify), monitoring host load/RAM, stopping when a wave degrades. e2e.
set -uo pipefail
cd /Users/vukasinkubet/dev/comp/apps/api
PID="${PID:-9ebbfc1f-8c57-4882-be8d-db3058c5e7a1}"
BASE=http://localhost:8008
PK=$(grep '^PLATINUM_API_KEY=' .env.local|head -1|cut -d= -f2-)
PURL=$(grep '^PLATINUM_API_URL=' .env.local|head -1|cut -d= -f2-); PURL="${PURL:-https://api.platinum.dev}"
K="$HOME/.ssh/platinum_prod_ed25519"
psql(){ docker exec supabase_db_kortix-local psql -U postgres -tA -c "$1" 2>/dev/null; }
nowms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
H(){ ssh -i "$K" -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes ubuntu@51.158.248.121 "$@"; }
mkdir -p /tmp/load
MINT_EMAIL='vukasinkubet@gmail.com' bun run scripts/_mint_jwt.ts >/dev/null 2>&1
JWT=$(cat /tmp/userjwt); HDR=(-H "Authorization: Bearer $JWT" -H 'Content-Type: application/json')

worker(){
  local w=$1 i=$2 t0; t0=$(nowms); local out=/tmp/load/$w-$i
  local sid; sid=$(curl -s -m20 "${HDR[@]}" -X POST "$BASE/v1/projects/$PID/sessions" -d '{"provider":"platinum","branch_already_created":false}'|python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
  [ -z "$sid" ] && { echo "ready=0 correct=0 fail=create" > "$out"; return; }
  local ext="" st="" row
  while :; do row=$(psql "select external_id||'|'||status from kortix.session_sandboxes where session_id='$sid' order by created_at desc limit 1;"); ext=${row%%|*}; st=${row##*|}; [ "$st" = active ] && [ -n "$ext" ] && break; [ $(( ($(nowms)-t0)/1000 )) -ge 240 ] && break; sleep 2; done
  [ -z "$ext" ] && { echo "ready=0 correct=0 fail=noactive" > "$out"; psql "delete from kortix.session_sandboxes where session_id='$sid';">/dev/null 2>&1; return; }
  local ta=$(( $(nowms)-t0 ))
  local rok=0; while :; do curl -s -m6 "${HDR[@]}" "$BASE/v1/p/$ext/8000/kortix/health" 2>/dev/null|grep -q '"runtimeReady":true' && { rok=1; break; }; [ $(( ($(nowms)-t0)/1000 )) -ge 240 ] && break; sleep 1; done
  local tr=$(( $(nowms)-t0 ))
  curl -s -m30 "${HDR[@]}" -X POST "$BASE/v1/projects/$PID/sessions/$sid/ensure-opencode" -d '{}' >/dev/null 2>&1
  local oc; oc=$(curl -s -m10 "${HDR[@]}" "$BASE/v1/p/$ext/8000/session?directory=%2Fworkspace"|python3 -c "import sys,json
try:
 d=json.load(sys.stdin);ss=d if isinstance(d,list) else d.get('sessions',d.get('data',[]));print(ss[0]['id'] if ss else '')
except: print('')" 2>/dev/null)
  local a=$((13+i)) b=$((17+w+i)) exp correct=0; exp=$((a*b))
  if [ -n "$oc" ]; then
    curl -s -m20 "${HDR[@]}" -X POST "$BASE/v1/p/$ext/8000/session/$oc/prompt_async?directory=%2Fworkspace" -d "{\"parts\":[{\"type\":\"text\",\"text\":\"What is $a multiplied by $b? Reply with only the number.\"}]}" -o /dev/null 2>/dev/null
    local tp; tp=$(nowms)
    while [ $(( ($(nowms)-tp)/1000 )) -lt 110 ]; do m=$(curl -s -m10 "${HDR[@]}" "$BASE/v1/p/$ext/8000/session/$oc/message?directory=%2Fworkspace"); echo "$m"|grep -q '"role":"assistant"' && echo "$m"|grep -qw "$exp" && { correct=1; break; }; sleep 2; done
  fi
  echo "ready=$rok correct=$correct ta=$ta tr=$tr tg=$(( $(nowms)-t0 )) ext=$ext" > "$out"
  curl -s -m15 -X DELETE "$PURL/v1/sandboxes/$ext" -H "Authorization: Bearer $PK" >/dev/null 2>&1
  psql "delete from kortix.session_sandboxes where session_id='$sid';" >/dev/null 2>&1
}

run_wave(){
  local N=$1; rm -f /tmp/load/$N-*; local ts; ts=$(nowms); local pids=()
  for i in $(seq 1 "$N"); do worker "$N" "$i" & pids+=($!); done
  local peak=0 peakram=0 vmax=0 peakcpu=0
  while :; do
    local alive=0 p; for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ "$alive" = 0 ] && break
    local s l r v cpu; s=$(H 'L=$(awk "{print \$1}" /proc/loadavg); R=$(free -g|awk "/Mem:/{print \$3}"); V=$(pgrep -c cloud-hypervisor 2>/dev/null||echo 0); C=$(top -bn1 2>/dev/null|awk "/Cpu\(s\)/{print int(100-\$8)}"|head -1); echo "$L ${R:-0} ${V:-0} ${C:-0}"' 2>/dev/null)
    l=$(echo "$s"|awk '{print $1}'); r=$(echo "$s"|awk '{print $2}'); v=$(echo "$s"|awk '{print $3}'); cpu=$(echo "$s"|awk '{print $4}')
    awk "BEGIN{exit !(${l:-0}>$peak)}" 2>/dev/null && peak=$l; awk "BEGIN{exit !(${r:-0}>$peakram)}" 2>/dev/null && peakram=$r; [ "${v:-0}" -gt "$vmax" ] 2>/dev/null && vmax=$v; [ "${cpu:-0}" -gt "$peakcpu" ] 2>/dev/null && peakcpu=$cpu
    sleep 4
  done
  wait
  python3 - "$N" "$peak" "$peakram" "$vmax" "$(( ($(nowms)-ts)/1000 ))" "$peakcpu" <<'PY'
import sys,glob
N,peak,peakram,vmax,dur,peakcpu=sys.argv[1:7]; N=int(N)
ready=correct=0; trs=[]; tgs=[]
for f in glob.glob(f"/tmp/load/{N}-*"):
    d=dict(x.split('=') for x in open(f).read().split() if '=' in x)
    if d.get('ready')=='1': ready+=1; trs.append(int(d.get('tr',0)))
    if d.get('correct')=='1': correct+=1; tgs.append(int(d.get('tg',0)))
P=lambda a,q:(sorted(a)[min(len(a)-1,int(len(a)*q))] if a else 0)
print(f"  WAVE N={N}: runtimeReady {ready}/{N} | agent-correct {correct}/{N} | ready p50 {P(trs,.5)}ms p95 {P(trs,.95)}ms | agent p50 {P(tgs,.5)}ms p95 {P(tgs,.95)}ms | host PEAK cpu {peakcpu}% load {peak}/48 RAM {peakram}G vms {vmax} | wave {dur}s")
sys.exit(0 if correct>=int(N*0.9) else 7)
PY
}

echo "=== MAX KORTIX LOAD TEST (real agent flow, ramp until degradation) ==="
H 'echo "  host baseline: load=$(cut -d\" \" -f1 /proc/loadavg) cores=$(nproc) RAM=$(free -g|awk "/Mem:/{print \$3}")/$(free -g|awk "/Mem:/{print \$2}")G"'
for N in 4 8 12; do
  run_wave "$N" || { echo "  -> wave $N degraded (agent-correct < 90%); host cpu above shows if it's host-bound or harness/LLM-bound"; }
done
echo "=== sweep any leftover running sandboxes for the kortix org ==="
curl -s -m12 "$PURL/v1/sandboxes" -H "Authorization: Bearer $PK"|python3 -c "import sys,json;d=json.load(sys.stdin);s=d if isinstance(d,list) else d.get('sandboxes',[]);[print(x.get('id')) for x in s if x.get('state')=='running']" 2>/dev/null | while read id; do [ -n "$id" ] && curl -s -m15 -o /dev/null -X DELETE "$PURL/v1/sandboxes/$id" -H "Authorization: Bearer $PK"; done
echo "  swept. final running: $(curl -s -m12 "$PURL/v1/sandboxes" -H "Authorization: Bearer $PK"|python3 -c "import sys,json;d=json.load(sys.stdin);s=d if isinstance(d,list) else d.get('sandboxes',[]);print(sum(1 for x in s if x.get('state')=='running'))" 2>/dev/null)"
echo DONE
