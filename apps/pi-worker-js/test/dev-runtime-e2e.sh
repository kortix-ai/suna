#!/usr/bin/env bash
# THE RUNTIME, DRIVEN THE WAY A PROJECT ACTUALLY DRIVES IT.
#
# The unit suites prove node, the TypeScript eraser and the plugin loader
# against fixtures they build themselves. This one proves the same things where
# they have to work: a real session on the dev stack, files written by the
# model into a real checkout, and the model calling the tools that come back.
#
# Every claim here failed at some point during the build for a reason a unit
# test could not have shown — a plugin filename that was root-absolute, a
# workspace walk handed a wrapper instead of an fs, a marker matched against a
# stale answer. The gap between "the loader works" and "a project can ship a
# tool" is exactly this file.
#
# It also holds the DEFAULT to account: none of it may provision a microVM. A
# runtime that quietly boots a 2 GB box to run `node -e 1` is not the runtime
# this is for.
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
hasenv(){ curl -s -m 60 -o /tmp/rt.env -w '%{http_code}' "$BASE/v1/projects/$PROJ/sessions/$1/environment" "${AH[@]}"; }

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
json.dump({"client_message_id":"cm-"+h,"message_id":"msg_"+h+t,"parts":[{"type":"text","text":sys.argv[1]}]}, open("/tmp/rt.prompt","w"))' "$text"
  curl -s -m 30 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$sid/prompts" "${JH[@]}" -d @/tmp/rt.prompt
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
get(){ curl -s -m 90 "$C$1" "${AH[@]}"; }

# ---------- 1. node runs a PROGRAM, not just a one-liner ----------
#
# `node -e` was the only thing ever proven live. A project runs scripts: a file
# on disk, importing another file beside it, awaiting at module scope, and
# leaving its output in the tree for the next command to read.
NODEOUT=$(ask "$SID" "Using only your bash tool (never the machine tool), write these two files and then run them.

Write lib/half.mjs containing exactly:
export const half = (n) => n / 2;

Write probe.mjs containing exactly:
import { half } from './lib/half.mjs';
import { writeFileSync } from 'node:fs';
const n = await Promise.resolve(84);
writeFileSync('node-wrote.txt', 'written by node');
console.log('half=' + half(n) + ' tla=ok');

Then run: node probe.mjs
Reply with only the line it printed." "half=" 300)
ck "node runs a SCRIPT FILE, and its ESM import of a file beside it resolves" \
  "$(printf '%s' "$NODEOUT" | grep -q 'half=42' && echo 1 || echo 0)" "got: $(printf '%s' "$NODEOUT" | head -c 90)"
ck "and top-level await works at module scope, where node allows it" \
  "$(printf '%s' "$NODEOUT" | grep -q 'tla=ok' && echo 1 || echo 0)" "got: $(printf '%s' "$NODEOUT" | head -c 90)"
# WHAT THE SCRIPT WROTE HAS TO BE IN THE TREE. A runtime whose writes evaporate
# when the command returns did not run the program, it simulated it.
WROTE=$(get "/file/content?path=node-wrote.txt")
ck "what node WROTE is in the checkout afterwards — asked of the file route, not of the model" \
  "$(R="$WROTE" jq_ 'import json,os;print(1 if "written by node" in (json.loads(os.environ["R"]).get("content") or "") else 0)')" \
  "$(printf '%s' "$WROTE" | head -c 120)"

TSOUT=$(ask "$SID" "Using only your bash tool, write probe.ts containing exactly:
const twice = (n: number): number => n * 2;
const v: number = await Promise.resolve(21);
console.log('ts=' + twice(v));

Then run: node probe.ts
Reply with only the line it printed." "ts=" 300)
ck "node runs TYPESCRIPT directly — the types come off and the program underneath runs" \
  "$(printf '%s' "$TSOUT" | grep -q 'ts=42' && echo 1 || echo 0)" "got: $(printf '%s' "$TSOUT" | head -c 90)"

# A CELL GENUINELY CANNOT SPAWN A PROCESS, and the failure has to say so and
# name the way out. Silence here is a model burning a turn on exit 127.
CPOUT=$(ask "$SID" "Using only your bash tool, run exactly: node -e \"try { require('child_process').execSync('ls'); } catch (e) { console.log(e.code + ' :: ' + e.message); }\" and reply with only the line it printed." "ENOSYS" 300)
ck "what a cell cannot do fails BY NAME and names the machine tool, rather than going quiet" \
  "$(printf '%s' "$CPOUT" | grep -q 'ENOSYS' && printf '%s' "$CPOUT" | grep -qi 'machine tool' && echo 1 || echo 0)" \
  "got: $(printf '%s' "$CPOUT" | head -c 110)"

ck "and none of that provisioned a microVM" \
  "$([ "$(hasenv "$SID")" = 404 ] && echo 1 || echo 0)" "GET .../environment -> $(hasenv "$SID")"

# ---------- 2. a project's own tools, including the ones that are wrong ----------
#
# One good plugin proves the happy path. The three beside it are the reason the
# loader exists: a project's mistake must reach its author as a sentence, and
# must not cost the tools that are fine.
ask "$SID" "Using only your bash tool, write these four files.

.kortix/pi/plugins/ok.js containing exactly:
export default async () => ({ tools: { addup: { description: 'Add two numbers.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, async execute(args) { return String(args.a + args.b); } } } });

.kortix/pi/plugins/boom.js containing exactly:
export default async () => ({ tools: { boom: { description: 'Always fails.', parameters: { type: 'object', properties: {} }, async execute() { throw new Error('boom on purpose'); } } } });

.kortix/pi/plugins/notafn.js containing exactly:
export default 5;

.kortix/pi/plugins/needsdep.js containing exactly:
import nope from 'definitely-not-installed';
export default async () => ({ tools: { nope: { description: 'x', parameters: {}, async execute() { return nope; } } } });

Then reply with only the word: fourwritten" "fourwritten" 300 >/dev/null
P=$(get "/plugins?reload=1")
ck "the good plugins load — a tool with arguments, and one that throws only when called" \
  "$(R="$P" jq_ 'import json,os
t=set(json.loads(os.environ["R"]).get("tools") or []); print(1 if {"addup","boom"} <= t else 0)')" \
  "$(printf '%s' "$P" | head -c 220)"
ck "a plugin that does not export a function is reported BY NAME, not silently skipped" \
  "$(R="$P" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if any("notafn.js" in x and "default-export a function" in x for x in (d.get("diagnostics") or [])) else 0)')" \
  "$(printf '%s' "$P" | head -c 220)"
# THERE IS NO npm HERE. A plugin whose dependency the project never committed
# cannot be made to work by trying harder, so the answer is WHICH module.
ck "a plugin needing a package the project does not ship says WHICH module is missing" \
  "$(R="$P" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if any("needsdep.js" in x and "definitely-not-installed" in x for x in (d.get("diagnostics") or [])) else 0)')" \
  "$(printf '%s' "$P" | head -c 220)"
ck "and the broken ones cost the good ones NOTHING — the agent still has its tools" \
  "$(R="$P" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if len(d.get("tools") or []) >= 2 and len(d.get("diagnostics") or []) >= 2 else 0)')" \
  "$(printf '%s' "$P" | head -c 220)"

ADD=$(ask "$SID" "Use your addup tool with a=19 and b=23. Reply with only the number it returned." "42" 300)
ck "the MODEL calls the project's tool WITH ARGUMENTS, and the arguments arrive" \
  "$(printf '%s' "$ADD" | grep -q '42' && echo 1 || echo 0)" "got: $(printf '%s' "$ADD" | head -c 80)"

# A PLUGIN'S THROW IS THE TOOL'S RESULT, NOT THE TURN'S END. The model has to
# be able to read the failure and carry on; an exception out of the tool would
# take the whole turn down with it.
BOOM=$(ask "$SID" "Use your boom tool once. It will fail. Reply with only the error text it returned." "boom on purpose" 300)
ck "a plugin that throws is the TOOL's failure, not the turn's — the model reads it and answers" \
  "$(printf '%s' "$BOOM" | grep -q 'boom on purpose' && echo 1 || echo 0)" "got: $(printf '%s' "$BOOM" | head -c 110)"

# ---------- 3. a plugin is EDITABLE, like the rest of the checkout ----------
ask "$SID" "Using only your bash tool, rewrite .kortix/pi/plugins/ok.js so addup MULTIPLIES instead of adding. The file must contain exactly:
export default async () => ({ tools: { addup: { description: 'Multiply two numbers.', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, async execute(args) { return String(args.a * args.b); } } } });

Then reply with only the word: rewritten" "rewritten" 300 >/dev/null
get "/plugins?reload=1" >/dev/null
MUL=$(ask "$SID" "Use your addup tool with a=6 and b=7. Reply with only the number it returned." "42" 300)
ck "editing a plugin changes what the model has — the project's tools are live, not baked in at boot" \
  "$(printf '%s' "$MUL" | grep -q '42' && echo 1 || echo 0)" "got: $(printf '%s' "$MUL" | head -c 80)"

ck "and after ALL of it there is still no environment — none of this needed a machine" \
  "$([ "$(hasenv "$SID")" = 404 ] && echo 1 || echo 0)" "GET .../environment -> $(hasenv "$SID")"

echo
echo "  the runtime, live: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
