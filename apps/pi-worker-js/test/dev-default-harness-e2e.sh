#!/usr/bin/env bash
# THE DEFAULT IS A CELL, AND NOTHING ELSE.
#
# A cell can now attach a full Linux machine on demand, and the moment it does,
# that machine becomes the workspace. That capability must not cost the DEFAULT
# anything: a session that was never asked for a machine must run entirely in
# its own isolate — no microVM provisioned, none billed, nothing to wait for —
# and every surface the product uses must work there.
#
# This suite is the guard on that sentence. It drives one session through the
# whole default surface, and asserts after every leg that the control plane
# still holds NO environment for it. Then it asks for a machine explicitly,
# proves the switch, and proves that a SECOND session created afterwards is
# still a plain cell — because a default that erodes one session at a time is
# the failure this exists to catch.
#
# It also holds the runtime to its own clock. Every proxied answer carries
# `x-cell-ms`, the isolate's own time, apart from the API's hop and the
# caller's distance. Measured 2026-09-11 from a laptop an ocean away: 450-730 ms
# per call end to end, of which the CELL was 1-28 ms. A regression inside the
# isolate is invisible in a wall-clock number and obvious in that header.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
N=$(dirname "$0")
BASE=${KORTIX_E2E_BASE:-https://pi-js.kortix.com}
PROJ=${KORTIX_E2E_PROJECT:-$(cat "$N/../../../scratchpad/e2e-project" 2>/dev/null || true)}
E2E_USER=${KORTIX_E2E_USER:-pt-e2e-1788648166@example.test}
E2E_PASS=${KORTIX_E2E_PASS:-Pt-e2e-2026!x}
[ -n "${PROJ:-}" ] || { echo "  SKIP: no KORTIX_E2E_PROJECT (the project this drives a session in)"; exit 0; }

PASS=0; FAIL=0
ck(){ if [ "$2" = 1 ]; then echo "  PASS $1"; PASS=$((PASS+1)); else echo "  FAIL $1 ${3:-}"; FAIL=$((FAIL+1)); fi; }
jq_(){ python3 -c "$1" 2>/dev/null || echo ""; }

SIGNIN=$(U="$E2E_USER" P="$E2E_PASS" python3 -c 'import json,os;print(json.dumps({"email":os.environ["U"],"password":os.environ["P"]}))')
SICODE=000
for try in 1 2 3; do
  SICODE=$(curl -s -m 30 -o /tmp/dh.auth -w '%{http_code}' -X POST "$BASE/v1/auth/sign-in/password" -H 'content-type: application/json' -d "$SIGNIN")
  [ "$SICODE" = "000" ] || break
  sleep 3
done
[ "$SICODE" = "000" ] && { echo "  SKIP: $BASE is unreachable (3 tries)"; exit 0; }
A=$(python3 -c 'import json
try: print(json.load(open("/tmp/dh.auth"))["session"]["access_token"])
except Exception: print("")')
[ -n "$A" ] || { echo "  FAIL sign-in reachable but returned no token (http $SICODE)"; exit 1; }
AH=(-H "authorization: Bearer $A"); JH=("${AH[@]}" -H 'content-type: application/json')

newsession(){
  local sid
  sid=$(curl -s -m 180 -X POST "$BASE/v1/projects/$PROJ/sessions" "${JH[@]}" -d '{}' | jq_ 'import json,sys;print(json.load(sys.stdin).get("session_id",""))')
  [ -n "$sid" ] || return 1
  local n=0 st=""
  while [ $n -lt 12 ]; do n=$((n+1))
    st=$(curl -s -m 60 -X POST "$BASE/v1/projects/$PROJ/sessions/$sid/start?wait_ms=8000" "${JH[@]}" -d '{}' | jq_ 'import json,sys;print(json.load(sys.stdin).get("stage","?"))')
    [ "$st" = ready ] && break
  done
  printf '%s' "$sid"
}
# The control plane's own answer to "does this session hold a machine?" — 404
# when it never asked for one. That is the whole claim, asked of the API rather
# than of the cell, because the cell cannot prove a box does not exist.
hasenv(){ curl -s -m 60 -o /tmp/dh.env -w '%{http_code}' "$BASE/v1/projects/$PROJ/sessions/$1/environment" "${AH[@]}"; }
# A STALE ANSWER MUST NOT COUNT AS THIS TURN'S. This polled for the marker in
# the LAST assistant message without checking that the message was new, so a
# marker that had appeared in ANY earlier answer matched the instant the prompt
# was posted — measured 2026-09-14: `uname -s` was "proved" by an answer from
# six turns earlier that happened to contain `linux`, and the machine was never
# attached at all. Remember which message was last BEFORE sending, and wait for
# a different one.
lastanswer(){ # lastanswer <sid> -> "<id>\n<text>"
  curl -s -m 60 "$BASE/v1/projects/$PROJ/sessions/$1/transcript?limit=100" "${AH[@]}" | jq_ 'import json,sys
t=[m for m in json.load(sys.stdin).get("messages",[]) if m.get("role")=="assistant" and (m.get("text") or "").strip()]
print(str(t[-1].get("id") or t[-1].get("message_id") or len(t)) if t else "-")
print(t[-1].get("text") if t else "")'
}
ask(){ # ask <sid> <prompt> <marker> <seconds>
  local sid=$1 text=$2 marker=$3 secs=${4:-180}
  local was id body out t=0
  was=$(lastanswer "$sid" | head -1)
  python3 -c '
import json,random,string,sys
h="".join(random.choice("0123456789abcdef") for _ in range(12))
t="".join(random.choice(string.ascii_letters+string.digits) for _ in range(14))
json.dump({"client_message_id":"cm-"+h,"message_id":"msg_"+h+t,"parts":[{"type":"text","text":sys.argv[1]}]}, open("/tmp/dh.prompt","w"))' "$text"
  curl -s -m 30 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$sid/prompts" "${JH[@]}" -d @/tmp/dh.prompt
  while [ $t -lt "$secs" ]; do
    out=$(lastanswer "$sid"); id=$(printf '%s' "$out" | head -1); body=$(printf '%s' "$out" | tail -n +2)
    [ "$id" != "$was" ] && printf '%s' "$body" | grep -qi "$marker" && { printf '%s' "$body"; return 0; }
    sleep 3; t=$((t+3))
  done
  printf '%s' "${body:-}"; return 1
}

SID=$(newsession) || { echo "  FAIL could not create a session"; exit 1; }
echo "  session $SID"
C="$BASE/v1/p/$SID/8080"
get(){ curl -s -m 60 "$C$1" "${AH[@]}"; }
# The isolate's OWN time for a call, from the header the proxy passes through.
cellms(){ curl -s -m 60 -D /tmp/dh.h -o /dev/null "$C$1" "${AH[@]}"; grep -i '^x-cell-ms' /tmp/dh.h | tr -d '\r' | sed 's/.*: *//'; }

# ---------- 1. born a cell ----------
ck "a fresh session holds NO environment — nothing was provisioned and nothing is billed" \
  "$([ "$(hasenv "$SID")" = 404 ] && echo 1 || echo 0)" "GET .../environment -> $(hasenv "$SID"): $(head -c 90 /tmp/dh.env)"
DIAG=$(get "/kortix/diag")
ck "and the runtime says so: the workspace is the cell, with no machine attached" \
  "$(D="$DIAG" jq_ 'import json,os
d=json.loads(os.environ["D"]); print(1 if d.get("runtime")=="cell" and d.get("workspace")=="cell" and d.get("environment") is None else 0)')" \
  "$(D="$DIAG" jq_ 'import json,os;d=json.loads(os.environ["D"]);print({k:d.get(k) for k in ("runtime","workspace","environment")})')"
ck "the model's tools run in the cell too" \
  "$(M="$(get /model)" jq_ 'import json,os;print(1 if json.loads(os.environ["M"])["tools"]["backend"]=="cell" else 0)')" \
  "$(M="$(get /model)" jq_ 'import json,os;print(json.loads(os.environ["M"])["tools"])')"

# ---------- 2. the whole default surface, in the cell ----------
MARK="dh$(date +%s)"
ANS=$(ask "$SID" "Use your write tool to create the file $MARK.txt containing exactly $MARK, then use your bash tool to run: ls $MARK.txt . Then reply with only the word: done" done 240)
ck "the agent writes a file and runs a shell command, entirely inside the cell" \
  "$(printf '%s' "$ANS" | grep -qi done && echo 1 || echo 0)" "got: $(printf '%s' "$ANS" | head -c 80)"
ck "the Files panel lists it" \
  "$(F="$(get "/file?path=")" M="$MARK" jq_ 'import json,os
print(1 if any(n.get("name")==os.environ["M"]+".txt" for n in json.loads(os.environ["F"])) else 0)')" \
  "$(F="$(get "/file?path=")" jq_ 'import json,os;print([n["name"] for n in json.loads(os.environ["F"])][:8])')"
ck "the viewer reads it back" \
  "$(F="$(get "/file/content?path=$MARK.txt")" M="$MARK" jq_ 'import json,os;print(1 if os.environ["M"] in (json.loads(os.environ["F"]).get("content") or "") else 0)')" \
  "$(get "/file/content?path=$MARK.txt" | head -c 80)"
ck "search finds it by name and by content" \
  "$(FF="$(get "/find/file?query=$MARK")" FT="$(get "/find?pattern=$MARK")" M="$MARK" jq_ 'import json,os
names=json.loads(os.environ["FF"]); text=json.loads(os.environ["FT"])
n=names if isinstance(names,list) else names.get("files") or []
print(1 if any(os.environ["M"] in str(x) for x in n) and any(os.environ["M"] in str(x) for x in text) else 0)')" \
  "names=$(get "/find/file?query=$MARK" | head -c 60) text=$(get "/find?pattern=$MARK" | head -c 60)"
ck "git sees it as an added file in the project's checkout" \
  "$(S="$(get /file/status)" M="$MARK" jq_ 'import json,os
print(1 if any(x.get("path")==os.environ["M"]+".txt" and x.get("status")=="added" for x in json.loads(os.environ["S"])) else 0)')" \
  "$(get /file/status | head -c 120)"
ck "the project's own agent prompt and skills are loaded, with no machine involved" \
  "$(SK="$(get /skills)" AG="$(get /agent)" jq_ 'import json,os
sk=json.loads(os.environ["SK"]); ag=json.loads(os.environ["AG"])
print(1 if len(sk.get("skills") or [])>0 and ag and ag[0].get("description") and "running in a cell" not in ag[0]["description"] else 0)')" \
  "skills=$(SK="$(get /skills)" jq_ 'import json,os;print(len(json.loads(os.environ["SK"]).get("skills") or []))')"
ck "STILL no environment after all of that — the default did not quietly grow a microVM" \
  "$([ "$(hasenv "$SID")" = 404 ] && echo 1 || echo 0)" "GET .../environment -> $(hasenv "$SID")"

# ---------- 2b. `node` RUNS IN THE CELL, with no machine ----------
#
# The cell is a JavaScript isolate whose engine permits dynamic evaluation, so
# `node` compiles the script here rather than needing a box. The version string
# is the proof that matters: `pi-cell` is this runtime, and a plain `v22.x`
# would mean the model escalated to a machine for work the cell can do.
NODEOUT=$(ask "$SID" "Do NOT use the machine tool. Using only your bash tool, run exactly: node -e \"const p=require('path');const os=require('os');console.log(process.version,p.join('a','b'),os.platform())\" and reply with only its output." "pi-cell" 240)
ck "node runs INSIDE the cell — its own version, and the core modules answering" \
  "$(printf '%s' "$NODEOUT" | grep -q "pi-cell" && printf '%s' "$NODEOUT" | grep -q "a/b" && echo 1 || echo 0)" "got: $(printf '%s' "$NODEOUT" | head -c 90)"
ck "and running JavaScript did not provision a microVM" \
  "$([ "$(hasenv "$SID")" = 404 ] && echo 1 || echo 0)" "GET .../environment -> $(hasenv "$SID")"

# ---------- 3. the isolate's own clock ----------
echo "  --- the cell's own time per call (x-cell-ms), apart from the API hop and this caller's distance:"
SLOW=0
for r in "/kortix/diag" "/session/$SID/message" "/file?path=" "/file/status" "/agent" "/session"; do
  MS=$(cellms "$r")
  printf '      %-34s %s ms\n' "${r/$SID/:id}" "${MS:-?}"
  # A whole number of MILLISECONDS, per call, inside the isolate. The budget is
  # generous on purpose: it is a tripwire for a regression of an order of
  # magnitude, not a benchmark.
  [ -n "$MS" ] && [ "$(printf '%.0f' "$MS")" -gt 250 ] && SLOW=$((SLOW+1))
done
ck "every route answers in the isolate in well under a quarter second — the runtime is not what a slow page is waiting on" \
  "$([ "$SLOW" = 0 ] && echo 1 || echo 0)" "$SLOW route(s) over budget"

# ---------- 4. commit-push, still with no machine ----------
CP=$(curl -s -m 300 -X POST "$C/kortix/git/commit-push" "${JH[@]}" -d "$(python3 -c 'import json,sys;print(json.dumps({"message":"default harness: "+sys.argv[1]}))' "$MARK")")
BRANCH=$(R="$CP" jq_ 'import json,os;print(json.loads(os.environ["R"]).get("branch") or "")')
HEAD=$(R="$CP" jq_ 'import json,os;print(json.loads(os.environ["R"]).get("headSha") or "")')
ck "the cell commits and pushes the session's work on its own — no machine, no daemon" \
  "$(R="$CP" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if d.get("ok") and d.get("committed") and d.get("pushed") and len(d.get("headSha") or "")==40 else 0)')" \
  "$(printf '%s' "$CP" | head -c 150)"
# ASK THE ORIGIN THROUGH THE API, NOT THROUGH A LOCAL git.
#
# `git ls-remote` over https makes git consult its credential helper, which on
# macOS is `osxkeychain`: one "allow access to your keychain" dialog PER CALL,
# and this suite asks up to four times per push. Suppressing the helper only
# trades the dialog for a 401, because the git proxy wants a Kortix token and
# not this session's bearer.
#
# `GET /v1/projects/:p/branches` answers the same question — what sha does the
# ORIGIN have for this branch — with the token the suite is already holding, and
# it is still the remote answering rather than the cell. No subprocess, no
# credential lookup, no prompt.
gitremote(){ # gitremote <branch> -> the sha the origin holds for it
  B="$1" R="$(curl -s -m 60 "$BASE/v1/projects/$PROJ/branches" "${AH[@]}")" jq_ 'import json,os
d=json.loads(os.environ["R"] or "{}")
print(next((b.get("tip") or "" for b in (d.get("branches") or []) if b.get("name")==os.environ["B"]), ""))'
}
if [ -n "$BRANCH" ] && [ -n "$HEAD" ]; then
  REMOTE=""
  for try in 1 2 3 4; do
    REMOTE=$(gitremote "$BRANCH")
    [ -n "$REMOTE" ] && break
    sleep 3
  done
  ck "and the ORIGIN has that commit — asked of the remote, not of the cell" \
    "$([ "$REMOTE" = "$HEAD" ] && echo 1 || echo 0)" "cell said $HEAD, origin says ${REMOTE:-<nothing>}"
else
  echo "  SKIP the push reported no branch or head to verify"
fi
ck "and STILL no environment — a push is not a reason to boot a machine" \
  "$([ "$(hasenv "$SID")" = 404 ] && echo 1 || echo 0)" "GET .../environment -> $(hasenv "$SID")"

# ---------- 4b. THE PROJECT'S OWN TOOLS ----------
#
# pi ships no plugin system, so this is the whole feature: a project writes a
# tool into its checkout and the model has it. Written in TypeScript and split
# across two files on purpose — both were impossible until the cell could strip
# types and resolve a require, and a single self-contained .js would prove
# neither.
ask "$SID" "Using only your bash tool, write two files.

.kortix/pi/plugins/lib/greet.ts containing exactly:
export const greet = (who: string): string => \`hi \${who}\`;

.kortix/pi/plugins/multi.ts containing exactly:
import { greet } from \"./lib/greet.js\";
export default async () => ({ tools: { multigreet: { description: \"Greet someone from a multi-file TypeScript plugin.\", parameters: { type: \"object\", properties: { who: { type: \"string\" } }, required: [\"who\"] }, async execute({ who }: { who: string }): Promise<string> { return greet(who); } } } });

Then reply with only the word: wroteplugin" "wroteplugin" 240 >/dev/null
PLUGS=$(get "/plugins?reload=1")
ck "a TypeScript plugin SPLIT ACROSS FILES loads — types erased, and './lib/greet.js' resolved to greet.ts" \
  "$(R="$PLUGS" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if "multigreet" in (d.get("tools") or []) else 0)')" \
  "$(printf '%s' "$PLUGS" | head -c 200)"
PLUGANS=$(ask "$SID" "Use your multigreet tool with who=Vukasin and reply with only what it returned." "hi Vukasin" 240)
ck "and the MODEL has that tool — the project extended its own agent" \
  "$(printf '%s' "$PLUGANS" | grep -q 'hi Vukasin' && echo 1 || echo 0)" "got: $(printf '%s' "$PLUGANS" | head -c 80)"
ck "and none of it provisioned a microVM" \
  "$([ "$(hasenv "$SID")" = 404 ] && echo 1 || echo 0)" "GET .../environment -> $(hasenv "$SID")"

# ---------- 5. the machine is OPT-IN, and only for the session that asked ----------
# `node --version` ALONE NO LONGER PROVES A MACHINE. The cell has its own node
# now, which answers v22.0.0-pi-cell — a string the old regex happily matched,
# so this claim passed while nothing was ever attached and the next two claims
# took the blame. `uname` is in CELL_MISSING: only a real box can answer it.
ANS2=$(ask "$SID" "Use the machine tool to run exactly: node --version && uname -s . Reply with only what it printed." "Linux" 300)
ck "asking for a machine gets one, and the model runs a real runtime on it" \
  "$(printf '%s' "$ANS2" | grep -q 'Linux' && printf '%s' "$ANS2" | grep -qE 'v[0-9]+\.[0-9]+\.[0-9]+' \
     && ! printf '%s' "$ANS2" | grep -q 'pi-cell' && echo 1 || echo 0)" "got: $(printf '%s' "$ANS2" | head -c 80)"
ck "now the control plane holds an active environment for THIS session" \
  "$([ "$(hasenv "$SID")" = 200 ] && printf '%s' "$(cat /tmp/dh.env)" | grep -q '"status":"active"' && echo 1 || echo 0)" "$(head -c 140 /tmp/dh.env)"
ck "and the workspace moved with it — the panel, git and the tools now answer from the machine" \
  "$(D="$(get /kortix/diag)" jq_ 'import json,os
d=json.loads(os.environ["D"]); print(1 if d.get("workspace")=="machine" and d.get("environment") else 0)')" \
  "$(D="$(get /kortix/diag)" jq_ 'import json,os;d=json.loads(os.environ["D"]);print({k:d.get(k) for k in ("workspace","environment")})')"

# THE NEXT SESSION IS STILL A PLAIN CELL. One session asking for a machine must
# not change what a session IS.
SID2=$(newsession) || { echo "  FAIL could not create a second session"; exit 1; }
ck "a session created afterwards is born a cell again, with no environment" \
  "$([ "$(hasenv "$SID2")" = 404 ] && echo 1 || echo 0)" "$SID2 -> $(hasenv "$SID2")"
ck "and its runtime says cell, not machine" \
  "$(D="$(curl -s -m 60 "$BASE/v1/p/$SID2/8080/kortix/diag" "${AH[@]}")" jq_ 'import json,os
d=json.loads(os.environ["D"]); print(1 if d.get("workspace")=="cell" and d.get("environment") is None else 0)')" \
  "$(curl -s -m 60 "$BASE/v1/p/$SID2/8080/kortix/diag" "${AH[@]}" | head -c 120)"

# A MACHINE THIS SUITE MADE IS A MACHINE THIS SUITE STOPS. An environment is a
# 2 GB microVM on one dev host; three left running exhausted it and every later
# suite that needed a cell got "no capacity" (2026-09-11).
curl -s -m 90 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/environment/stop" "${JH[@]}" -d '{}' || true

echo
echo "  the default harness, live: $PASS passed, $FAIL failed"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
