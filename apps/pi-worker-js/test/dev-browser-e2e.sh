#!/usr/bin/env bash
# THE BROWSER'S OWN PATH, end to end. Not the API's /events — the in-box proxy
# route the web client actually uses: /v1/p/<box>/8000/global/event.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
N=$(dirname "$0"); BASE=https://pi-js.kortix.com; PROJ=$(cat "$N/e2e-project")
ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
P=0; F=0
ck(){ if [ "$2" = 1 ]; then echo "  PASS $1"; P=$((P+1)); else echo "  FAIL $1 ${3:-}"; F=$((F+1)); fi; }
A=$(curl -s -m 30 -X POST "$BASE/v1/auth/sign-in/password" -H 'content-type: application/json' \
  -d '{"email":"pt-e2e-1788648166@example.test","password":"Pt-e2e-2026!x"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["session"]["access_token"])')
AH=(-H "authorization: Bearer $A" -H 'content-type: application/json')
T0=$(ms)
SID=$(curl -s -m 180 -X POST "$BASE/v1/projects/$PROJ/sessions" "${AH[@]}" -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("session_id",""))')
[ -n "$SID" ] || { echo "  create failed"; exit 1; }
for i in $(seq 1 12); do
  ST=$(curl -s -m 60 -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/start?wait_ms=8000" "${AH[@]}" -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("stage","?"))')
  [ "$ST" = ready ] && break; done
TR=$(ms)
echo "  session $SID  ready in $((TR-T0)) ms"
BOX=$(bash "$N/dbq.sh" "SELECT external_id FROM kortix.session_sandboxes WHERE session_id='$SID'" 2>/dev/null | python3 -c "import json,sys;r=sys.stdin.read();i=r.find('[');print(json.loads(r[i:])[0]['external_id'])" 2>/dev/null)
NS=$(bash "$N/dbq.sh" "SELECT count(*) AS n FROM kortix.session_sandboxes WHERE external_id='$BOX' AND status='active'" 2>/dev/null | python3 -c "import json,sys;r=sys.stdin.read();i=r.find('[');print(json.loads(r[i:])[0]['n'])" 2>/dev/null)
echo "  box $BOX  sessions on it: $NS"
ck "the session has its own box — no sharing" "$([ "$NS" = 1 ] && echo 1 || echo 0)" "sessions=$NS"

# THE BROWSER'S STREAM
echo "$(ms)" > /tmp/be2e.base
( curl -sN -m 90 "$BASE/v1/p/$BOX/8000/global/event" -H "authorization: Bearer $A" -H 'accept: text/event-stream' \
  | while IFS= read -r l; do [ -z "$l" ] && continue
      echo "$(python3 -c 'import time;print(int(time.time()*1000))') $l"; done ) > /tmp/be2e.sse 2>&1 &
PUMP=$!
sleep 4
ATT=$(head -c 200 /tmp/be2e.sse | tr '\n' ' ')
ck "the browser's in-box stream attaches" "$(grep -qE 'connected|kortix|event' /tmp/be2e.sse && echo 1 || echo 0)" "got: ${ATT:-nothing}"

python3 "$N/mkprompt.py" "Reply with exactly one word: streamcheck" /tmp/be2e.body
TP=$(ms)
PC=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/be2e.body)
ck "the prompt is accepted" "$([ "$PC" = 200 ] || [ "$PC" = 202 ] && echo 1 || echo 0)" "http $PC"
t=0; while [ $t -lt 90 ]; do grep -q "streamcheck" /tmp/be2e.sse && break; sleep 0.5; t=$((t+1)); done
TA=$(ms)
FIRST=$(grep -m1 -nE 'message.part.delta|message_update|text' /tmp/be2e.sse | head -1 | cut -d: -f1)
D=$(grep -cE 'message.part.delta|message_update' /tmp/be2e.sse 2>/dev/null | head -1)
kill $PUMP 2>/dev/null || true
ck "the answer arrived ON THE BROWSER'S STREAM, not by polling" \
  "$(grep -q 'streamcheck' /tmp/be2e.sse && echo 1 || echo 0)" "$(tail -3 /tmp/be2e.sse | head -c 150)"
echo "  frames carrying deltas: ${D:-0}   prompt->answer $((TA-TP)) ms"
echo "  --- event types on the browser stream:"
grep -oE '"type":"[a-z._]+"' /tmp/be2e.sse | sort | uniq -c | sort -rn | head -6 | sed 's/^/    /'
echo; echo "  browser path: $P passed, $F failed"
exit $([ "$F" -eq 0 ] && echo 0 || echo 1)
