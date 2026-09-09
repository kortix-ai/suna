#!/usr/bin/env bash
# DOES A CELL'S FILE SURVIVE ITS ISOLATE BEING REBUILT?
#
# The box-destruction probe reported files 3 -> 0, but it destroys a whole
# sandbox — and on a shared host that takes every other session with it. This
# asks the narrower question that actually happens in production: celld evicts
# an idle isolate, rebuilds it on the next request, and the transcript comes
# back from object storage. Do the FILES?
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
API=https://api-dev.platinum.dev
TOK=$(sed -n 's/^default = //p' ~/.config/platinum/credentials | head -1)
H=(-H "Authorization: Bearer $TOK" -H 'content-type: application/json')
ID=""; PASS=0; FAIL=0
ck(){ if [ "$2" = 1 ]; then echo "  PASS $1"; PASS=$((PASS+1)); else echo "  FAIL $1 ${3:-}"; FAIL=$((FAIL+1)); fi; }
cleanup(){ [ -n "$ID" ] && curl -s -m 90 -o /dev/null -X DELETE "$API/v1/sandboxes/$ID" "${H[@]}"; echo "  cleaned up $ID"; }
trap cleanup EXIT
# ITS OWN BOX. The previous version of this ran against a shared cell host and
# destroying it orphaned 49 other sessions.
B=$(python3 -c "import json;print(json.dumps({'template':'pt-celld','runtime':'cell','worker':'pi-agent','name':'file-durable','cpu':2,'ram_mb':4096,'expose':[{'port':8080,'public':True}],'env':{'CELLD_IDLE_EVICT_S':'20'}}))")
ID=$(curl -s -m 300 "${H[@]}" -X POST "$API/v1/sandboxes?wait_for_state=running&wait_timeout_ms=240000" -d "$B" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -n "$ID" ] || { echo "  create failed"; exit 1; }
U="https://8080-$(echo "${ID#sbx_}" | tr 'A-Z' 'a-z').eu-west.sbx-dev.platinum.dev"
for _ in $(seq 1 400); do [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$U/health")" = 200 ] && break; sleep 0.25; done
NONCE="durable-$$-$(date +%s)"; C="sess-$NONCE"
echo "  box $ID   cell $C"
# A scripted turn that writes a file — no model, no network.
python3 - "$NONCE" > /tmp/fd.json <<'PY'
import json, sys
nonce = sys.argv[1]
print(json.dumps({"env": {"TOOLS_BACKEND": "cell", "SCRIPT": json.dumps([
  {"tool": "bash", "id": nonce + "-w",
   "args": {"command": "mkdir -p /work && printf '%s\n' '" + nonce + "' > /work/" + nonce + ".txt && ls /work"}},
  {"text": "written"}])}}))
PY
curl -s -m 30 -o /dev/null "$U/kortix/env?c=$C" -X POST -H 'content-type: application/json' -d @/tmp/fd.json
curl -s -m 60 -o /dev/null -X POST "$U/session/$C/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"go"}]}'
for _ in $(seq 1 90); do
  st=$(curl -s -m 20 "$U/turns?c=$C" | python3 -c 'import json,sys;t=json.load(sys.stdin)["turns"];print(t[-1]["status"] if t else "none")' 2>/dev/null || echo none)
  { [ "$st" = done ] || [ "$st" = error ]; } && break; sleep 1; done
I1=$(curl -s -m 20 "$U/ping?c=$C" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("instance"))')
F1=$(curl -s -m 20 "$U/model?c=$C" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("tools") or {}).get("files"))')
echo "  before eviction: instance=$I1 files=$F1"
ck "the cell wrote the file and counts it" "$([ "${F1:-0}" -gt 0 ] 2>/dev/null && echo 1 || echo 0)" "files=$F1"
# DO NOT WATCH IT. The first version polled /ping every 10 s waiting for the
# eviction and so kept the isolate alive for four minutes — then reported that
# the files survived a rebuild that never happened. Two vacuous passes. Wait in
# silence for several times the idle window, then look once.
echo "  --- leaving the cell completely alone for 90s (idle window is 20s)"
sleep 90
I2=$(curl -s -m 20 "$U/ping?c=$C" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("instance"))')
echo "  after 90s of silence: $I1 -> $I2"
ck "the isolate really was rebuilt — a NEW instance" "$([ "$I2" != "$I1" ] && echo 1 || echo 0)" "$I1 -> $I2"
F2=$(curl -s -m 20 "$U/model?c=$C" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("tools") or {}).get("files"))')
echo "  after:  files=$F2"
ck "its files came back with it" "$([ "${F2:-0}" -ge "${F1:-0}" ] 2>/dev/null && [ "${F2:-0}" -gt 0 ] && echo 1 || echo 0)" "files $F1 -> $F2"
# And the content, not just the count.
python3 - "$NONCE" > /tmp/fd2.json <<'PY'
import json, sys
nonce = sys.argv[1]
print(json.dumps({"env": {"TOOLS_BACKEND": "cell", "SCRIPT": json.dumps([
  {"tool": "bash", "id": nonce + "-r", "args": {"command": "cat /work/" + nonce + ".txt"}},
  {"text": "read"}])}}))
PY
curl -s -m 30 -o /dev/null "$U/kortix/env?c=$C" -X POST -H 'content-type: application/json' -d @/tmp/fd2.json
curl -s -m 60 -o /dev/null -X POST "$U/session/$C/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"read it"}]}'
for _ in $(seq 1 90); do
  st=$(curl -s -m 20 "$U/turns?c=$C" | python3 -c 'import json,sys;t=json.load(sys.stdin)["turns"];print(t[-1]["status"] if t else "none")' 2>/dev/null || echo none)
  { [ "$st" = done ] || [ "$st" = error ]; } && break; sleep 1; done
OUT=$(curl -s -m 20 "$U/history?c=$C" | python3 -c '
import json,sys
msgs=json.load(sys.stdin).get("messages",[])
tr=[m for m in msgs if m.get("role")=="toolResult"]
m=(tr[-1].get("message",{}) if tr else {})
if (m.get("details") or {}).get("replayed"): print("REPLAYED"); raise SystemExit
print("".join(c.get("text","") for c in m.get("content",[]) if isinstance(c,dict)))')
ck "and the agent can read its own file back after the rebuild" \
   "$(printf '%s' "$OUT" | grep -q "$NONCE" && echo 1 || echo 0)" "read back: $(printf '%s' "$OUT" | head -c 80)"
echo; echo "  a file survives its isolate: $PASS passed, $FAIL failed"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
