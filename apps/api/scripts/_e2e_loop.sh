#!/usr/bin/env bash
# Kortix session e2e loop: create -> resolve sandbox -> runtimeReady -> verify daemon -> cleanup.
# Loops until N consecutive fast+healthy runs (or max rounds). FAA: also asserts
# the daemon is actually serving :8000 in-guest (startup regressions left it dead before).
set -uo pipefail
cd "$(dirname "$0")/.."   # apps/api
DIR=/Users/vukasinkubet/dev/comp/apps/api
PID="${PID:-9ebbfc1f-8c57-4882-be8d-db3058c5e7a1}"
WANT_OK=${WANT_OK:-3}      # consecutive healthy runs required
MAX=${MAX:-8}
CAP=${CAP:-90}            # seconds per round to reach runtimeReady
PLATINUM_API_KEY=$(grep '^PLATINUM_API_KEY=' "$DIR/.env.local" 2>/dev/null | head -1 | cut -d= -f2-)
PLATINUM_API_URL=$(grep '^PLATINUM_API_URL=' "$DIR/.env.local" 2>/dev/null | head -1 | cut -d= -f2-)
PURL="${PLATINUM_API_URL:-https://api.platinum.dev}"
[ -z "$PLATINUM_API_KEY" ] && { echo "FATAL: no PLATINUM_API_KEY in $DIR/.env.local"; exit 1; }
psql() { docker exec supabase_db_kortix-local psql -U postgres -tA -c "$1" 2>/dev/null; }
nowms() { python3 -c 'import time;print(int(time.time()*1000))'; }   # macOS date lacks %N

ok=0
for round in $(seq 1 "$MAX"); do
  MINT_EMAIL='vukasinkubet@gmail.com' bun run scripts/_mint_jwt.ts >/dev/null 2>&1
  JWT=$(cat /tmp/userjwt)
  t0=$(nowms)
  sid=$(curl -s -m20 "http://localhost:8008/v1/projects/$PID/sessions" -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' -d '{"branch_already_created":false}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
  if [ -z "$sid" ]; then echo "round $round: CREATE_FAILED"; continue; fi

  # resolve sandbox external_id + active status from DB
  ext=""; st=""
  while :; do
    row=$(psql "select external_id||'|'||status from kortix.session_sandboxes where session_id='$sid';")
    ext=${row%%|*}; st=${row##*|}
    [ "$st" = "active" ] && [ -n "$ext" ] && break
    now=$(nowms); [ $(( (now-t0)/1000 )) -ge "$CAP" ] && break
    sleep 0.2
  done
  t_active=$(( $(nowms) - t0 ))
  if [ "$st" != "active" ]; then echo "round $round: NO_ACTIVE_SANDBOX (st=$st) +${t_active}ms"; continue; fi

  # poll runtimeReady through the comp proxy (the FE path)
  ready=""; health=""
  while :; do
    health=$(curl -s -m5 "http://localhost:8008/v1/p/$ext/8000/kortix/health" -H "Authorization: Bearer $JWT" 2>/dev/null)
    echo "$health" | grep -q '"runtimeReady":true' && { ready=1; break; }
    now=$(nowms); [ $(( (now-t0)/1000 )) -ge "$CAP" ] && break
    sleep 0.25
  done
  t_ready=$(( $(nowms) - t0 ))

  # in-guest assertion: daemon serving :8000 (FAA — proves no claim-crash)
  cat > /tmp/eb.json <<EOF
{"cmd":["sh","-c","ss -ltn 2>/dev/null | grep -q :8000 && echo BOUND || echo DEAD"],"timeout_ms":8000}
EOF
  bound=$(curl -s -m15 "$PURL/v1/sandboxes/$ext/exec" -H "Authorization: Bearer $PLATINUM_API_KEY" -H 'Content-Type: application/json' --data @/tmp/eb.json 2>/dev/null | python3 -c "import sys,json;print((json.load(sys.stdin).get('result',{}).get('stdout','') or '').strip())" 2>/dev/null)

  if [ -n "$ready" ] && [ "$bound" = "BOUND" ]; then
    ok=$((ok+1))
    echo "round $round: OK ready+${t_ready}ms active+${t_active}ms :8000=$bound  (streak $ok/$WANT_OK)  sbx=$ext"
  else
    ok=0
    echo "round $round: FAIL ready=${ready:-no}+${t_ready}ms :8000=${bound:-?} health=$(echo "$health" | head -c 120)  sbx=$ext"
  fi

  # cleanup: delete the sandbox (self-created) so nothing accumulates
  curl -s -m15 -X DELETE "$PURL/v1/sandboxes/$ext" -H "Authorization: Bearer $PLATINUM_API_KEY" >/dev/null 2>&1
  psql "delete from kortix.session_sandboxes where session_id='$sid';" >/dev/null 2>&1

  [ "$ok" -ge "$WANT_OK" ] && { echo "PASS: $WANT_OK consecutive healthy runs"; exit 0; }
done
echo "DONE (streak $ok/$WANT_OK)"; [ "$ok" -ge "$WANT_OK" ] && exit 0 || exit 2
