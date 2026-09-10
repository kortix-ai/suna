#!/usr/bin/env bash
# THE BROWSER'S OWN PATH, end to end, on the pi-js dev stack.
#
# Not the API's /events — the in-box proxy route the web client actually opens.
# The SDK builds every in-box call on `sandbox.base_url` when the backend hands
# a proxy-shaped one (packages/sdk runtimeUrlForSandbox), so this reads that
# field off the session's own /start answer and opens `${base_url}/global/event`
# exactly as the app does.
#
# ONE RUNNER PER PROJECT, NOT ONE BOX PER SESSION. A box per session was the
# design flaw the owner named on 2026-09-09 ("never place celld inside a
# microVM"): a 4 GB VM booted per session, ~2 s to ready, and a capacity
# ceiling that made sessions fail to create at all. A project's sessions now
# share one cell runner (`pi-cell-<hash(project)>`), and what keeps them apart
# is ADDRESSING: the base_url names the SESSION, the proxy resolves that exact
# row, and the cell serves that session's isolate. Measured after the fix:
# adopt 500-694 ms create / 549-717 ms ready, two streams, zero cross-talk.
#
# SKIP rather than fail where the stack is not reachable or not configured; a
# reachable stack that answers wrong is a FAILURE.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
N=$(dirname "$0"); BASE=${KORTIX_E2E_BASE:-https://pi-js.kortix.com}
PROJ=${KORTIX_E2E_PROJECT:-}
[ -n "$PROJ" ] || { echo "  SKIP: no KORTIX_E2E_PROJECT (the project this drives a session in)"; exit 0; }
E2E_EMAIL=${KORTIX_E2E_EMAIL:-pt-e2e-1788648166@example.test}
E2E_PASSWORD=${KORTIX_E2E_PASSWORD:-Pt-e2e-2026!x}
ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
P=0; F=0
ck(){ if [ "$2" = 1 ]; then echo "  PASS $1"; P=$((P+1)); else echo "  FAIL $1 ${3:-}"; F=$((F+1)); fi; }
j(){ python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else d)' "$1"; }

SICODE=$(curl -s -m 30 -o /tmp/be2e.si -w '%{http_code}' -X POST "$BASE/v1/auth/sign-in/password" -H 'content-type: application/json' \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$E2E_EMAIL" "$E2E_PASSWORD")")
if [ "$SICODE" = "000" ]; then echo "  SKIP: $BASE is unreachable"; exit 0; fi
A=$(j session.access_token < /tmp/be2e.si)
[ -n "$A" ] || { echo "  FAIL sign-in answered $SICODE with no token"; exit 1; }
AH=(-H "authorization: Bearer $A" -H 'content-type: application/json')

T0=$(ms)
SID=$(curl -s -m 180 -X POST "$BASE/v1/projects/$PROJ/sessions" "${AH[@]}" -d '{}' | j session_id)
[ -n "$SID" ] || { echo "  FAIL create returned no session_id"; exit 1; }
: > /tmp/be2e.start
for i in $(seq 1 12); do
  curl -s -m 60 -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/start?wait_ms=8000" "${AH[@]}" -d '{}' > /tmp/be2e.start
  [ "$(j stage < /tmp/be2e.start)" = ready ] && break; done
TR=$(ms)
echo "  session $SID  ready in $((TR-T0)) ms"
BOX=$(j sandbox.external_id < /tmp/be2e.start); BURL=$(j sandbox.base_url < /tmp/be2e.start)
if [ -z "$BOX" ] || [ -z "$BURL" ]; then
  curl -s -m 30 "$BASE/v1/projects/$PROJ/sessions/$SID" "${AH[@]}" > /tmp/be2e.sess
  [ -n "$BOX" ] || BOX=$(j sandbox.external_id < /tmp/be2e.sess); [ -n "$BURL" ] || BURL=$(j sandbox.base_url < /tmp/be2e.sess)
fi
echo "  box $BOX  base_url $BURL"
ck "the session reports its box and a base_url the SDK will use" "$([ -n "$BOX" ] && [ -n "$BURL" ] && echo 1 || echo 0)"
ck "the base_url names the SESSION, so its stream cannot be another session's" "$([ "${BURL##*/p/}" = "$SID/8080" ] && echo 1 || echo 0)" "$BURL"
PTOK=$(sed -n 's/^default = //p' ~/.config/platinum/credentials 2>/dev/null | head -1)
if [ -n "$PTOK" ] && [ -n "$BOX" ]; then
  BNAME=$(curl -s -m 30 -H "Authorization: Bearer $PTOK" "${PT_API_URL:-https://api-dev.platinum.dev}/v1/sandboxes/$BOX" | j name)
  ck "the session rides the project's shared cell runner, not a box of its own" "$(echo "$BNAME" | grep -q '^pi-cell-' && echo 1 || echo 0)" "box name=$BNAME"
fi

# THE BROWSER'S STREAM — on the session's own base_url, as the SDK opens it.
: > /tmp/be2e.sse
( curl -sN -m 90 "$BURL/global/event" -H "authorization: Bearer $A" -H 'accept: text/event-stream' > /tmp/be2e.sse 2>&1 ) &
PUMP=$!
for i in $(seq 1 40); do [ -s /tmp/be2e.sse ] && break; sleep 0.2; done
ATT=$(head -c 200 /tmp/be2e.sse | tr '\n' ' ')
ck "the browser's in-box stream attaches (200 + hello)" "$(grep -q 'kortix.hello' /tmp/be2e.sse && echo 1 || echo 0)" "got: ${ATT:-nothing}"

W=streamcheck$RANDOM
# THE PROMPT'S OWN ID, kept: the runtime echoes the user message the moment it
# accepts the prompt (worker.js prompt_async), so the word this claim looks for
# is on the stream TWICE — once in this tab's own echo, once in the answer.
# Searching the whole stream matched the echo, closed it before the model had
# written anything, and reported deltas=0 (2026-09-10).
python3 -c 'import json,random,string,sys
h="".join(random.choice("0123456789abcdef") for _ in range(12)); t="".join(random.choice(string.ascii_letters+string.digits) for _ in range(14))
mid="msg_"+h+t
json.dump({"client_message_id":"cm-"+h,"message_id":mid,"parts":[{"type":"text","text":sys.argv[1]}]}, open(sys.argv[2],"w"))
open(sys.argv[3],"w").write(mid)' "Reply with exactly one word: $W" /tmp/be2e.body /tmp/be2e.mid
MID=$(cat /tmp/be2e.mid)
TP=$(ms)
PC=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/be2e.body)
ck "the prompt is accepted" "$([ "$PC" = 200 ] || [ "$PC" = 202 ] && echo 1 || echo 0)" "http $PC"
# THE USER MESSAGE COMES BACK FIRST, under the id this tab minted — that echo
# is what retires the optimistic bubble, and without it the new turn vanished
# from the transcript for a second on every send.
t=0; while [ $t -lt 30 ]; do grep -q "$MID" /tmp/be2e.sse && break; sleep 0.5; t=$((t+1)); done
ck "the runtime echoes the user message under the id the client sent" "$(grep -q "\"id\":\"$MID\"" /tmp/be2e.sse && grep -q "$MID-p0" /tmp/be2e.sse && echo 1 || echo 0)" "echo after $((  $(ms) - TP )) ms"
# The ANSWER's frames: everything that is not this prompt's own echo.
answer(){ grep -v "$MID" /tmp/be2e.sse; }
t=0; while [ $t -lt 180 ]; do answer | grep -q "$W" && break; sleep 0.5; t=$((t+1)); done
TA=$(ms)
kill $PUMP 2>/dev/null || true
D=$(answer | grep -c 'message.part.delta')
ck "the answer arrived ON THE BROWSER'S STREAM, not by polling" "$(answer | grep -q "$W" && echo 1 || echo 0)" "$(tail -c 150 /tmp/be2e.sse)"
ck "and it arrived as deltas" "$([ "$D" -ge 1 ] && echo 1 || echo 0)" "deltas=$D"
echo "  frames carrying deltas: $D   prompt->answer $((TA-TP)) ms"
echo; echo "  browser path: $P passed, $F failed"
exit $([ "$F" -eq 0 ] && echo 0 || echo 1)
