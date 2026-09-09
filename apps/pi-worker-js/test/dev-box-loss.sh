#!/usr/bin/env bash
# DOES A SESSION SURVIVE LOSING ITS BOX ENTIRELY?
#
# An isolate rebuild is the common case and is covered. This is the other one:
# a host is destroyed — a deploy blips cells, a node is replaced — and the
# session is served from a DIFFERENT box. Cell state is keyed by name across
# the deployment's storage, so a new box asking for the same cell name should
# find everything. The transcript was shown to survive this in an earlier tick;
# the FILES never were, and a probe has been reporting them lost for weeks.
#
# Two boxes, one cell name, nothing shared but object storage.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
API=https://api-dev.platinum.dev
TOK=$(sed -n 's/^default = //p' ~/.config/platinum/credentials | head -1)
H=(-H "Authorization: Bearer $TOK" -H 'content-type: application/json')
A=""; B=""; PASS=0; FAIL=0
ck(){ if [ "$2" = 1 ]; then echo "  PASS $1"; PASS=$((PASS+1)); else echo "  FAIL $1 ${3:-}"; FAIL=$((FAIL+1)); fi; }
cleanup(){ for x in $A $B; do curl -s -m 90 -o /dev/null -X DELETE "$API/v1/sandboxes/$x" "${H[@]}"; done; echo "  cleaned up ${A:-} ${B:-}"; }
trap cleanup EXIT
mkbox(){ python3 -c "import json;print(json.dumps({'template':'pt-celld','runtime':'cell','worker':'pi-agent','name':'$1','cpu':2,'ram_mb':4096,'expose':[{'port':8080,'public':True}]}))" \
  | curl -s -m 300 "${H[@]}" -X POST "$API/v1/sandboxes?wait_for_state=running&wait_timeout_ms=240000" -d @- \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))'; }
url(){ echo "https://8080-$(echo "${1#sbx_}" | tr 'A-Z' 'a-z').eu-west.sbx-dev.platinum.dev"; }
wait_up(){ for _ in $(seq 1 400); do [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$1/health")" = 200 ] && return 0; sleep 0.25; done; return 1; }
# A BOX THAT JUST CAME UP CAN ANSWER /health BEFORE IT ANSWERS ANYTHING ELSE.
# The first version read the transcript straight after wait_up, got a body that
# was not JSON, and reported "the transcript did not follow" — a parse failure
# wearing a data-loss result. Retry until it parses, then believe it.
jget(){ # jget <url> <python expr over `d`>
  for _ in $(seq 1 20); do
    out=$(curl -s -m 25 "$1" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit(1)
print($2)" 2>/dev/null) && { printf '%s' "$out"; return 0; }
    sleep 1
  done
  printf 'UNREADABLE'; }

NONCE="boxloss-$$-$(date +%s)"; C="cell-$NONCE"
A=$(mkbox boxloss-a); [ -n "$A" ] || { echo "  create A failed"; exit 1; }
UA=$(url "$A"); wait_up "$UA" || { echo "  A never served"; exit 1; }
echo "  box A $A   cell $C"

python3 - "$NONCE" > /tmp/bl.json <<'PY'
import json, sys
n = sys.argv[1]
print(json.dumps({"env": {"TOOLS_BACKEND": "cell", "SCRIPT": json.dumps([
  {"tool": "bash", "id": n + "-w",
   "args": {"command": "mkdir -p /work && printf '%s\n' '" + n + "' > /work/" + n + ".txt && ls /work"}},
  {"text": "written"}])}}))
PY
curl -s -m 30 -o /dev/null "$UA/kortix/env?c=$C" -X POST -H 'content-type: application/json' -d @/tmp/bl.json
curl -s -m 60 -o /dev/null -X POST "$UA/session/$C/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"go"}]}'
for _ in $(seq 1 90); do
  st=$(curl -s -m 20 "$UA/turns?c=$C" | python3 -c 'import json,sys;t=json.load(sys.stdin)["turns"];print(t[-1]["status"] if t else "none")' 2>/dev/null || echo none)
  { [ "$st" = done ] || [ "$st" = error ]; } && break; sleep 1; done
F1=$(jget "$UA/model?c=$C" '(d.get("tools") or {}).get("files")')
M1=$(jget "$UA/history?c=$C" 'len(d.get("messages",[]))')
echo "  on A: files=$F1 messages=$M1"
ck "the cell wrote its file on box A" "$([ "${F1:-0}" -gt 0 ] 2>/dev/null && echo 1 || echo 0)" "files=$F1"

echo "  --- destroying box A completely"
curl -s -m 120 -o /dev/null -X DELETE "$API/v1/sandboxes/$A" "${H[@]}"; OLDA=$A; A=""
for _ in $(seq 1 60); do
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "${H[@]}" "$API/v1/sandboxes/$OLDA")
  [ "$code" = 404 ] && break; sleep 2; done
ck "box A is really gone, not merely stopped" "$([ "$code" = 404 ] && echo 1 || echo 0)" "GET -> $code"

B=$(mkbox boxloss-b); [ -n "$B" ] || { echo "  create B failed"; exit 1; }
UB=$(url "$B"); wait_up "$UB" || { echo "  B never served"; exit 1; }
echo "  box B $B — a different box, same deployment, same cell name"
M2=$(jget "$UB/history?c=$C" 'len(d.get("messages",[]))')
F2=$(jget "$UB/model?c=$C" '(d.get("tools") or {}).get("files")')
echo "  on B: files=$F2 messages=$M2"
ck "the transcript followed the cell to the new box" "$([ "${M2:-0}" -ge "${M1:-0}" ] 2>/dev/null && [ "${M2:-0}" -gt 0 ] && echo 1 || echo 0)" "messages $M1 -> $M2"
ck "and so did the files" "$([ "${F2:-0}" -ge "${F1:-0}" ] 2>/dev/null && [ "${F2:-0}" -gt 0 ] && echo 1 || echo 0)" "files $F1 -> $F2"

python3 - "$NONCE" > /tmp/bl2.json <<'PY'
import json, sys
n = sys.argv[1]
print(json.dumps({"env": {"TOOLS_BACKEND": "cell", "SCRIPT": json.dumps([
  {"tool": "bash", "id": n + "-r", "args": {"command": "cat /work/" + n + ".txt"}},
  {"text": "read"}])}}))
PY
curl -s -m 30 -o /dev/null "$UB/kortix/env?c=$C" -X POST -H 'content-type: application/json' -d @/tmp/bl2.json
T0=$(python3 -c 'import time;print(int(time.time()*1000))')
curl -s -m 60 -o /dev/null -X POST "$UB/session/$C/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"read it"}]}'
for _ in $(seq 1 120); do
  st=$(curl -s -m 20 "$UB/turns?c=$C" | python3 -c 'import json,sys;t=json.load(sys.stdin)["turns"];print(t[-1]["status"] if t else "none")' 2>/dev/null || echo none)
  { [ "$st" = done ] || [ "$st" = error ]; } && break; sleep 1; done
T1=$(python3 -c 'import time;print(int(time.time()*1000))')
OUT=$(curl -s -m 20 "$UB/history?c=$C" | python3 -c '
import json,sys
msgs=json.load(sys.stdin).get("messages",[])
tr=[m for m in msgs if m.get("role")=="toolResult"]
m=(tr[-1].get("message",{}) if tr else {})
if (m.get("details") or {}).get("replayed"): print("REPLAYED"); raise SystemExit
print("".join(c.get("text","") for c in m.get("content",[]) if isinstance(c,dict)))')
echo "  turn on B took $((T1-T0)) ms"
ck "a turn on the NEW box runs, and reads the file written on the old one" \
   "$(printf '%s' "$OUT" | grep -q "$NONCE" && echo 1 || echo 0)" "read back: $(printf '%s' "$OUT" | head -c 80)"
echo; echo "  a session survives losing its box: $PASS passed, $FAIL failed"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
