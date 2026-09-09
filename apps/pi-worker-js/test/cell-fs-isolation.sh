#!/usr/bin/env bash
# TWO SESSIONS IN ONE CELL SANDBOX DO NOT SHARE /work.
#
# celld gives each named isolate its own SQLite, and execenv.cell.js keeps the
# agent's filesystem there — so isolation is structural. This proves it on the
# platform, because "structural" is what three cross-session defects also looked
# like before they were measured: the transcript root, the session token and the
# turn ledger were all per-BOX state that a shared host turned into a leak.
#
# NO MODEL. Each session gets its own SCRIPT through POST /kortix/env?c=<id>, so
# the turn is deterministic. Four earlier attempts at this test went through the
# gateway and timed out, then reported a vacuous PASS — a test that cannot fail
# is worse than no test, so the verdict here refuses to pass on silence.
set -uo pipefail
cd "$(dirname "$0")/.."
API=${PT_API_URL:-https://api-dev.platinum.dev}
TOK=${PT_SANDBOX_KEY:-$(grep -E '^default[[:space:]]*=' ~/.config/platinum/credentials 2>/dev/null | sed -E 's/^default[[:space:]]*=[[:space:]]*"?//; s/"?[[:space:]]*$//')}
[ -n "$TOK" ] || { echo "  SKIP: no Platinum dev token"; exit 0; }
H=(-H "Authorization: Bearer $TOK" -H 'content-type: application/json')
PASS=0; FAIL=0
ck(){ if [ "$2" = 1 ]; then echo "  PASS $1"; PASS=$((PASS+1)); else echo "  FAIL $1 ${3:-}"; FAIL=$((FAIL+1)); fi; }
NONCE="tenant-a-$$-$(date +%s)"
TMP=$(mktemp -d); ID=""
cleanup(){ [ -n "$ID" ] && curl -s -m 90 -o /dev/null -X DELETE "$API/v1/sandboxes/$ID" "${H[@]}"; rm -rf "$TMP"; }
trap cleanup EXIT
python3 - "$TMP" "$NONCE" <<'PY'
import json, sys
tmp, nonce = sys.argv[1], sys.argv[2]
def body(cmd):
    return {"env": {"SCRIPT": json.dumps([
        {"tool": "bash", "id": "c1", "args": {"command": cmd}}, {"text": "done"}]),
        "TOOLS_BACKEND": "cell"}}
open(f"{tmp}/a.json", "w").write(json.dumps(body(
    f"mkdir -p /work && printf '%s\\n' '{nonce}' > /work/mine.txt && ls /work")))
open(f"{tmp}/b.json", "w").write(json.dumps(body("ls /work")))
PY
B=$(python3 -c "import json;print(json.dumps({'template':'pt-celld','runtime':'cell','worker':'pi-agent','name':'fsiso-'+__import__('os').environ.get('USER','ci'),'cpu':2,'ram_mb':4096,'expose':[{'port':8080,'public':True}]}))")
ID=$(curl -s -m 300 "${H[@]}" -X POST "$API/v1/sandboxes?wait_for_state=running&wait_timeout_ms=240000" -d "$B" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -n "$ID" ] || { echo "  FAIL could not create a cell sandbox"; exit 1; }
U="https://8080-$(echo "${ID#sbx_}" | tr 'A-Z' 'a-z').eu-west.sbx-dev.platinum.dev"
for _ in $(seq 1 400); do [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$U/health")" = 200 ] && break; sleep 0.25; done
echo "  cell $ID"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$U/health")" = 200 ] || { echo "  FAIL the cell never served on $U"; exit 1; }

# Retried, because one HTTP call to a box that is still settling must not decide
# a correctness suite: the first run of this in all.sh failed on a single empty
# response from session B's push and reported the whole thing failed.
push(){ local r n=0
  while [ $n -lt 8 ]; do
    n=$((n+1))
    r=$(curl -s -m 30 "$U/kortix/env?c=$1" -X POST -H 'content-type: application/json' -d @"$2")
    a=$(printf '%s' "$r" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("applied",0))
except Exception: print(0)')
    [ "$a" = 2 ] && { printf '%s' "$a"; return 0; }
    sleep 1
  done
  printf '%s' "${a:-0}"; }
# The LAST tool result only: a cell that has run before also holds earlier turns.
# Shape-agnostic on purpose: the transcript's tool-result shape has changed
# under this test twice, and a parser that knows too much reports silence.
lastresult(){ curl -s -m 20 "$U/history?c=$1" | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw); msgs=d.get("messages",[])
    print(json.dumps(msgs[-3:]) if msgs else "")
except Exception:
    print(raw[:400])'; }
run(){ curl -s -m 60 -o /dev/null -X POST "$U/session/$1/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"go"}]}'
  for _ in $(seq 1 90); do
    st=$(curl -s -m 20 "$U/turns?c=$1" | python3 -c 'import json,sys;t=json.load(sys.stdin)["turns"];print(t[-1]["status"] if t else "none")' 2>/dev/null || echo none)
    { [ "$st" = done ] || [ "$st" = error ]; } && break; sleep 1; done; }

[ "$(push sess-a "$TMP/a.json")" = 2 ] || { echo "  FAIL could not configure session A"; exit 1; }
run sess-a; A=$(lastresult sess-a)
ck "session A wrote its file and sees it" "$(printf '%s' "$A" | grep -q 'mine.txt' && echo 1 || echo 0)" "A saw: $A"

[ "$(push sess-b "$TMP/b.json")" = 2 ] || { echo "  FAIL could not configure session B"; exit 1; }
run sess-b; Bout=$(lastresult sess-b)
# Refuse to pass on silence: B must have produced a listing at all.
ck "session B's turn actually ran" "$(printf '%s' "$Bout" | grep -q '.' && [ -n "$Bout" ] && echo 1 || echo 0)" "B saw nothing"
ck "session B's /work does NOT contain session A's file" \
   "$(printf '%s' "$Bout" | grep -q 'mine.txt' && echo 0 || echo 1)" "B saw: $Bout"
ck "and B cannot read its contents" \
   "$(printf '%s' "$Bout" | grep -q "$NONCE" && echo 0 || echo 1)" "B saw the nonce"
echo
echo "  two sessions, one cell sandbox: $PASS passed, $FAIL failed"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
