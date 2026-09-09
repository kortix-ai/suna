#!/usr/bin/env bash
# TWO SESSIONS IN ONE CELL SANDBOX DO NOT SHARE /workspace.
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
# A CELL NAME IS GLOBAL TO THE DEPLOYMENT'S STORAGE, NOT SCOPED TO THE SANDBOX,
# and a tool-call id is the ledger's primary key. Both were fixed strings here
# ("sess-a", "sess-b", "c1"), and that is why this suite passed five times
# without ever running a command.
#
# Measured on dev 2026-09-09: a sandbox created seconds earlier, asked for cell
# `sess-b`, answered with FORTY messages written 100 minutes before by a box
# that no longer exists — create a cell sandbox and GET /history?c=<a name an
# older box used> to repeat it. So every run of this test
# inherited the previous run's cell — including its op ledger, where tool call
# `c1` was already `done`. pitools.js serves a completed call FROM THE LEDGER
# rather than re-running it, correctly, and marks it `details.replayed`. The
# transcript then showed a listing nobody had just produced:
#
#   {"toolCallId":"c1", ... "text":"mine.txt\nproof.txt\n",
#    "details":{"replayed":true}}
#
# Under a mutant that put BOTH sessions in one cell — isolation removed — the
# suite still passed, three for three. A verdict that survives the removal of
# what it verifies is not a verdict.
python3 - "$TMP" "$NONCE" <<'PY'
import json, sys
tmp, nonce = sys.argv[1], sys.argv[2]
def body(cmd, who):
    return {"env": {"SCRIPT": json.dumps([
        {"tool": "bash", "id": f"{nonce}-{who}", "args": {"command": cmd}}, {"text": "done"}]),
        "TOOLS_BACKEND": "cell"}}
# A'S FILE IS NAMED AFTER THE NONCE, and B never names it.
#
# The first version had A write /workspace/mine.txt and asserted that B's output did
# not contain the string "mine.txt". B's shell said
# `cat: /workspace/mine.txt: No such file or directory` — the isolation held, and the
# test failed on the error message PROVING it held. A verdict that a correct
# answer can break is not a verdict.
#
# Now the only place the nonce can appear in B's output is if B really saw A's
# file: B lists /workspace and cats every .txt in it through a glob, so a miss
# produces no filename at all.
open(f"{tmp}/a.json", "w").write(json.dumps(body(
    f"mkdir -p /workspace && printf '%s\\n' '{nonce}' > /workspace/{nonce}.txt && ls /workspace", "a")))
open(f"{tmp}/b.json", "w").write(json.dumps(body(
    "ls /workspace; echo ---; cat /workspace/*.txt 2>/dev/null; echo B-RAN-TO-THE-END", "b")))
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
# THE TOOL RESULT ONLY, and never the request that produced it.
#
# This used to hand back the last three MESSAGES, so "B ran to the end" matched
# the string inside B's own `echo B-RAN-TO-THE-END` argument, and an earlier
# "B does not see mine.txt" matched `cat: /workspace/mine.txt: No such file` — the
# error that PROVED isolation held. Both verdicts were reading the question.
#
# A replayed result is not evidence either: it is the ledger answering, not the
# filesystem, so it is reported and the caller refuses it.
lastresult(){ curl -s -m 20 "$U/history?c=$1" | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw); msgs=d.get("messages",[])
except Exception:
    print("UNPARSEABLE " + raw[:300]); raise SystemExit
tr=[m for m in msgs if m.get("role")=="toolResult"]
if not tr: print("NO-TOOL-RESULT"); raise SystemExit
m=tr[-1].get("message",{})
if (m.get("details") or {}).get("replayed"): print("REPLAYED-FROM-LEDGER"); raise SystemExit
print("".join(c.get("text","") for c in m.get("content",[]) if isinstance(c,dict)))'; }
run(){ curl -s -m 60 -o /dev/null -X POST "$U/session/$1/prompt_async" -H 'content-type: application/json' -d '{"parts":[{"type":"text","text":"go"}]}'
  for _ in $(seq 1 90); do
    st=$(curl -s -m 20 "$U/turns?c=$1" | python3 -c 'import json,sys;t=json.load(sys.stdin)["turns"];print(t[-1]["status"] if t else "none")' 2>/dev/null || echo none)
    { [ "$st" = done ] || [ "$st" = error ]; } && break; sleep 1; done; }

[ "$(push "a-$NONCE" "$TMP/a.json")" = 2 ] || { echo "  FAIL could not configure session A"; exit 1; }
run "a-$NONCE"; A=$(lastresult "a-$NONCE")
ck "session A really ran its command — the ledger did not answer for it" \
   "$(printf '%s' "$A" | grep -qE 'REPLAYED|NO-TOOL-RESULT|UNPARSEABLE' && echo 0 || echo 1)" "A: $A"
ck "session A wrote its file and its own listing shows it" \
   "$(printf '%s' "$A" | grep -q "$NONCE" && echo 1 || echo 0)" "A saw: $A"

[ "$(push "b-$NONCE" "$TMP/b.json")" = 2 ] || { echo "  FAIL could not configure session B"; exit 1; }
run "b-$NONCE"; Bout=$(lastresult "b-$NONCE")
# Refuse to pass on silence: B must have run its script to the last line, not
# merely returned something. A turn that timed out also "produced output".
ck "session B's command ran to its last line, and ran for real" \
   "$(printf '%s' "$Bout" | grep -q 'B-RAN-TO-THE-END' && echo 1 || echo 0)" "B: $Bout"
ck "session B neither lists nor reads session A's file" \
   "$(printf '%s' "$Bout" | grep -q "$NONCE" && echo 0 || echo 1)" "B saw the nonce: $Bout"
echo
echo "  two sessions, one cell sandbox: $PASS passed, $FAIL failed"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
