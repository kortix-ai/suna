#!/usr/bin/env bash
# THE WHOLE THING, ONCE, THROUGH THE DOOR A USER USES.
#
# Everything in this session was verified in pieces: streaming here, the
# projection there, the turn ledger somewhere else. This runs one session from
# the public API through every leg that matters, in order, and refuses to pass
# on silence at each step.
#
# The leg that has never been checked end to end is the SECOND prompt. The
# turn_end 403 left the ledger record open, so the next prompt waited behind
# `turn_active` forever — the user's "3-4 business days to load". That fix was
# proved at the ledger; this proves it at the door.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
N=$(dirname "$0")
# CONFIGURED FROM THE ENVIRONMENT, so this can run anywhere the deployment is
# reachable — and SKIP rather than fail where it is not. A suite that cannot
# run must not be able to report success.
BASE=${KORTIX_E2E_BASE:-https://pi-js.kortix.com}
PROJ=${KORTIX_E2E_PROJECT:-$(cat "$N/../../../scratchpad/e2e-project" 2>/dev/null || true)}
E2E_USER=${KORTIX_E2E_USER:-pt-e2e-1788648166@example.test}
E2E_PASS=${KORTIX_E2E_PASS:-Pt-e2e-2026!x}
[ -n "${PROJ:-}" ] || { echo "  SKIP: no KORTIX_E2E_PROJECT (the project this drives a session in)"; exit 0; }
ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
# ONE PROMPT BODY, built by python into a file. Doing this inline inside a
# command substitution ate the braces of the `parts` array and sent a malformed
# body the API answered 400 to — which the first version of this suite reported
# as "the second prompt was refused".
mkprompt(){ python3 -c '
import json, random, string, sys
h = "".join(random.choice("0123456789abcdef") for _ in range(12))
t = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(14))
json.dump({"client_message_id": "cm-" + h, "message_id": "msg_" + h + t,
           "parts": [{"type": "text", "text": sys.argv[1]}]}, open(sys.argv[2], "w"))' "$1" "$2"; }
PASS=0; FAIL=0
ck(){ if [ "$2" = 1 ]; then echo "  PASS $1"; PASS=$((PASS+1)); else echo "  FAIL $1 ${3:-}"; FAIL=$((FAIL+1)); fi; }

# The env on a command must not be expected to reach a python inside a command
# SUBSTITUTION — that subshell runs first. Build the body, then send it.
SIGNIN=$(U="$E2E_USER" P="$E2E_PASS" python3 -c 'import json,os;print(json.dumps({"email":os.environ["U"],"password":os.environ["P"]}))')
SICODE=$(curl -s -m 30 -o /tmp/de2e.auth -w '%{http_code}' -X POST "$BASE/v1/auth/sign-in/password" \
  -H 'content-type: application/json' -d "$SIGNIN")
# A SKIP THAT FIRES ON A BUG IS WORSE THAN A FAILURE. Unreachable is a skip;
# reachable-and-rejected is a failure. The first version skipped on both, and
# hid a broken sign-in body as "cannot sign in".
if [ "$SICODE" = "000" ]; then echo "  SKIP: $BASE is unreachable"; exit 0; fi
A=$(python3 -c 'import json,sys
try: print(json.load(open("/tmp/de2e.auth"))["session"]["access_token"])
except Exception: print("")')
[ -n "$A" ] || { echo "  FAIL sign-in reachable but returned no token (http $SICODE): $(head -c 140 /tmp/de2e.auth)"; exit 1; }
AH=(-H "authorization: Bearer $A" -H 'content-type: application/json')

# ---------- 1. create ----------
T0=$(ms)
SID=$(curl -s -m 180 -X POST "$BASE/v1/projects/$PROJ/sessions" "${AH[@]}" -d '{}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("session_id",""))')
[ -n "$SID" ] || { echo "  FAIL create returned no session"; exit 1; }
TC=$(ms); echo "  session $SID"
ck "the API created a session" 1

# ---------- 2. start until ready ----------
n=0; ST=""
while [ $n -lt 12 ]; do n=$((n+1))
  ST=$(curl -s -m 60 -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/start?wait_ms=8000" "${AH[@]}" -d '{}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("stage","?"))')
  [ "$ST" = ready ] && break; done
TR=$(ms)
ck "it reaches stage=ready" "$([ "$ST" = ready ] && echo 1 || echo 0)" "stage=$ST after $n call(s)"

# ---------- 3. the UI's session open ----------
BUN=$(curl -s -m 60 "$BASE/v1/projects/$PROJ/sessions/$SID/open-bundle" "${AH[@]}")
TB=$(ms)
echo "$BUN" | python3 -c '
import json,sys;d=json.load(sys.stdin);r=d.get("runtime") or {}
print("   bundle: runtime known=%s reason=%s | keys=%s" % (r.get("known"), r.get("reason"), len(d.keys())))'
ck "the open bundle answers with a session, a transcript and a runtime leg" \
  "$(printf '%s' "$BUN" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(1 if all(k in d for k in ("session","transcript","runtime","models")) else 0)')" ""

# ---------- 4. attach the stream the UI attaches ----------
echo "$(ms)" > /tmp/de2e.t0
( curl -sN -m 150 "$BASE/v1/projects/$PROJ/sessions/$SID/events" -H "authorization: Bearer $A" -H 'accept: text/event-stream' \
  | while IFS= read -r line; do
      [ -z "$line" ] && continue
      echo "$(( $(python3 -c 'import time;print(int(time.time()*1000))') - $(cat /tmp/de2e.t0) )) $line"
    done ) > /tmp/de2e.log 2>&1 &
PUMP=$!
sleep 3

# ---------- 5. prompt one ----------
mkprompt "Reply with exactly the word: alpha" /tmp/de2e.b1
TP1=$(ms)
P1=$(curl -s -m 30 -o /tmp/de2e.p1 -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/de2e.b1)
ck "the first prompt is accepted" "$([ "$P1" = 200 ] || [ "$P1" = 202 ] && echo 1 || echo 0)" "http $P1 $(head -c 120 /tmp/de2e.p1)"
ans(){ curl -s -m 60 "$BASE/v1/projects/$PROJ/sessions/$SID/transcript?limit=30" "${AH[@]}" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
t=[ (m.get("text") or "") for m in d.get("messages",[]) if m.get("role")=="assistant" ]
print([x for x in t if x.strip()][-1] if [x for x in t if x.strip()] else "")'; }
t=0; A1=""
while [ $t -lt 90 ]; do A1=$(ans); printf '%s' "$A1" | grep -qi alpha && break; sleep 1; t=$((t+1)); done
TA1=$(ms)
ck "the first answer arrives, and is the answer asked for" \
  "$(printf '%s' "$A1" | grep -qi alpha && echo 1 || echo 0)" "got: $(printf '%s' "$A1" | head -c 60)"

# ---------- 6. THE SECOND PROMPT — the leg that used to hang ----------
mkprompt "Reply with exactly the word: bravo" /tmp/de2e.b2
TP2=$(ms)
P2=$(curl -s -m 30 -o /tmp/de2e.p2 -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/de2e.b2)
ck "the second prompt is accepted, not refused with turn_active" \
  "$([ "$P2" = 200 ] || [ "$P2" = 202 ] && echo 1 || echo 0)" "http $P2 $(head -c 160 /tmp/de2e.p2)"
t=0; A2=""
while [ $t -lt 120 ]; do A2=$(ans); printf '%s' "$A2" | grep -qi bravo && break; sleep 1; t=$((t+1)); done
TA2=$(ms)
ck "the second answer arrives — the turn ledger really closed" \
  "$(printf '%s' "$A2" | grep -qi bravo && echo 1 || echo 0)" "got: $(printf '%s' "$A2" | head -c 60)"

# ---------- 6b. A TURN THAT USES THE SHELL, and one that reads back what it
# wrote. This is the agent's actual job and it has never been driven through
# the public API — only through the cell's own routes with a scripted model.
NONCE="e2e-$(date +%s)-$$"
mkprompt "Use the shell to run exactly: mkdir -p /workspace && printf '%s' '$NONCE' > /workspace/e2e.txt && echo WROTE. Then reply with only the word: wrote" /tmp/de2e.b3
TP3=$(ms)
P3=$(curl -s -m 30 -o /tmp/de2e.p3 -w '%{http_code}' -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/de2e.b3)
ck "a tool-using prompt is accepted" "$([ "$P3" = 200 ] || [ "$P3" = 202 ] && echo 1 || echo 0)" "http $P3"
t=0; A3=""
while [ $t -lt 150 ]; do A3=$(ans); printf '%s' "$A3" | grep -qi wrote && break; sleep 1; t=$((t+1)); done
TA3=$(ms)
ck "the agent ran the shell and said so" "$(printf '%s' "$A3" | grep -qi wrote && echo 1 || echo 0)" "got: $(printf '%s' "$A3" | head -c 70)"

mkprompt "Use the shell to run exactly: cat /workspace/e2e.txt . Then reply with only what it printed." /tmp/de2e.b4
TP4=$(ms)
curl -s -m 30 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/de2e.b4
t=0; A4=""
while [ $t -lt 150 ]; do A4=$(ans); printf '%s' "$A4" | grep -q "$NONCE" && break; sleep 1; t=$((t+1)); done
TA4=$(ms)
ck "and a LATER turn reads the file back — the workspace persists between turns" \
  "$(printf '%s' "$A4" | grep -q "$NONCE" && echo 1 || echo 0)" "got: $(printf '%s' "$A4" | head -c 70)"

# ---------- 6c. THE PROJECT'S OWN CONFIGURATION, not the runtime's defaults.
#
# Three things travel from the repository into the running model, and each of
# them was silently absent on pi-js until 2026-09-10: the skills directory the
# MANIFEST names, the system prompt the project's agent `.md` carries, and the
# instructions in AGENTS.md. Every one of them fails as "the agent answered,
# just as itself", which is why they need claims of their own.
#
# The e2e project bumped `kortix_version` to 3 on 2026-09-06, which MOVES the
# config dir from `.kortix/opencode` to `.kortix/pi`. The cell had that path
# hard-coded and read an empty directory; the control plane resolved it
# correctly and compiled the project's agent from a `.md` that was no longer
# there, so the compiled config carried a name and no prompt.
CELL="$BASE/v1/p/$SID/8080"
MANI=$(curl -s -m 60 "$CELL/file/content?path=kortix.yaml" "${AH[@]}" \
  | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("content") or "")
except Exception: print("")')
# The schema's own rule (packages/manifest-schema manifestDefaultConfigDir):
# `.kortix/pi` from v3, `.kortix/opencode` before it, unless spelled out.
WANTDIR=$(M="$MANI" python3 -c '
import os, re
m = os.environ["M"]
spelled = re.search(r"^(?:pi|opencode):\s*$\s+^\s+config_dir:\s*\"?([^\"\n]+)\"?\s*$", m, re.M)
if spelled: print(spelled.group(1).strip().rstrip("/"))
else:
    v = re.search(r"^kortix_version:\s*(\d+)", m, re.M)
    print(".kortix/pi" if v and int(v.group(1)) >= 3 else ".kortix/opencode")')
SK=$(curl -s -m 60 "$CELL/skills" "${AH[@]}")
SKDIRS=$(printf '%s' "$SK" | python3 -c 'import json,sys;print(",".join(json.load(sys.stdin).get("dirs") or []))')
SKN=$(printf '%s' "$SK" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("skills") or []))')
echo "  --- project config: manifest dir $WANTDIR | skills $SKN in $SKDIRS"
if [ -z "$MANI" ]; then
  echo "  SKIP the project has no kortix.yaml — nothing declares a config dir"
else
  ck "the cell reads skills from the directory the MANIFEST names, not a hard-coded one" \
    "$(printf '%s' "$SKDIRS" | grep -q "/workspace/$WANTDIR/skills" && echo 1 || echo 0)" "wanted /workspace/$WANTDIR/skills, got $SKDIRS"
  ck "and it finds the project's skills there" "$([ "${SKN:-0}" -gt 0 ] && echo 1 || echo 0)" "$SKN skills"
fi
# The compiled agent, as the client's own /agent route reports it. A project
# agent carries the description from its `.md` frontmatter; the runtime's
# stand-in says "The session's agent, running in a cell."
AG=$(curl -s -m 60 "$CELL/agent" "${AH[@]}")
AGDESC=$(printf '%s' "$AG" | python3 -c '
import json,sys
try: a=json.load(sys.stdin); print((a[0].get("description") or "") if isinstance(a,list) and a else "")
except Exception: print("")')
ck "the /agent route reports the PROJECT's agent, with the description from its own .md" \
  "$([ -n "$AGDESC" ] && ! printf '%s' "$AGDESC" | grep -q "running in a cell" && echo 1 || echo 0)" "description: $(printf '%s' "$AGDESC" | head -c 90)"

# ---------- 6d. AND THE SAME TWO THINGS AS THE MODEL SEES THEM ----------
# The routes above report what the cell HOLDS. Only the model can say what it
# was actually run with, so one turn asks for both: the first sentence of its
# instructions (the agent `.md`) and the passphrase (AGENTS.md).
PASSPHRASE=$(curl -s -m 60 "$CELL/file/content?path=AGENTS.md" "${AH[@]}" \
  | python3 -c 'import json,re,sys
try: t=json.load(sys.stdin).get("content") or ""
except Exception: t=""
m=re.search(r"passphrase is `([^`]+)`", t)
print(m.group(1) if m else "")')
AGENTMD=$(curl -s -m 60 "$CELL/file/content?path=$WANTDIR/agents/$(printf '%s' "$AG" | python3 -c '
import json,sys
try: a=json.load(sys.stdin); print((a[0].get("name") or "") if isinstance(a,list) and a else "")
except Exception: print("")').md" "${AH[@]}" \
  | python3 -c 'import json,re,sys
try: t=json.load(sys.stdin).get("content") or ""
except Exception: t=""
body=re.sub(r"^---.*?^---\s*", "", t, flags=re.S|re.M).strip()
# The first SENTENCE, which is what the model is asked to quote back.
print(re.sub(r"[*_`]", "", body.split(".")[0]).strip())')
if [ -z "$PASSPHRASE" ] && [ -z "$AGENTMD" ]; then
  echo "  SKIP this project declares neither AGENTS.md nor an agent .md body"
else
  mkprompt "Quote the first sentence of your system instructions verbatim. Then on a new line, give the project passphrase and nothing else. Do not use any tools." /tmp/de2e.b5
  TP5=$(ms)
  curl -s -m 30 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/de2e.b5
  t=0; A5=""
  while [ $t -lt 150 ]; do A5=$(ans); [ -n "$PASSPHRASE" ] && printf '%s' "$A5" | grep -q "$PASSPHRASE" && break; sleep 1; t=$((t+1)); done
  TA5=$(ms)
  echo "  --- the model's own account: $(printf '%s' "$A5" | head -c 160)"
  if [ -n "$PASSPHRASE" ]; then
    ck "the model followed AGENTS.md — it answered with the passphrase only that file carries" \
      "$(printf '%s' "$A5" | grep -q "$PASSPHRASE" && echo 1 || echo 0)" "got: $(printf '%s' "$A5" | head -c 90)"
  fi
  if [ -n "$AGENTMD" ]; then
    ck "and it is running the PROJECT's system prompt — it quoted the first sentence of the agent's own .md" \
      "$(printf '%s' "$A5" | tr -d '*_`' | grep -qF "$AGENTMD" && echo 1 || echo 0)" "wanted: $(printf '%s' "$AGENTMD" | head -c 80)"
  fi
fi

# ---------- 6e. THE MACHINE: a full Linux environment, attached on demand.
#
# The cell's shell has no runtimes. The model is told so, and told the way out:
# the `machine` tool, whose first call asks the control plane for the session's
# ENVIRONMENT — a Platinum box from the project's own image, with node, pnpm,
# python and the repo on the session branch — and runs there over the daemon's
# RPC. Three things have to be true at once for this to count: the model chose
# the tool and got a real answer; the control plane holds an active
# environment for this session; and the cell says it is attached to that same
# box. Each was measured on dev 2026-09-11: 10 s to attach, node v22.23.1.
mkprompt "Use the machine tool to run exactly: node --version && git branch --show-current . Then reply with only what it printed, nothing else." /tmp/de2e.b6
TP6=$(ms)
curl -s -m 30 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${AH[@]}" -d @/tmp/de2e.b6
t=0; A6=""
while [ $t -lt 240 ]; do A6=$(ans); printf '%s' "$A6" | grep -q "$SID" && break; sleep 2; t=$((t+2)); done
TA6=$(ms)
echo "  --- the machine said: $(printf '%s' "$A6" | head -c 120)"
ck "the model ran node on the MACHINE — a version came back, and the branch is this session's" \
  "$(printf '%s' "$A6" | grep -qE 'v[0-9]+\.[0-9]+\.[0-9]+' && printf '%s' "$A6" | grep -q "$SID" && echo 1 || echo 0)" "got: $(printf '%s' "$A6" | head -c 100)"
ENVROW=$(curl -s -m 60 "$BASE/v1/projects/$PROJ/sessions/$SID/environment" "${AH[@]}")
ENVID=$(printf '%s' "$ENVROW" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(d.get("external_id") or "")
except Exception: print("")')
ck "the control plane holds an ACTIVE environment for this session, with a box id and an edge address" \
  "$(printf '%s' "$ENVROW" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(1 if d.get("status")=="active" and d.get("external_id") and (d.get("preview_url") or "").startswith("https://") else 0)
except Exception: print(0)')" "$(printf '%s' "$ENVROW" | head -c 160)"
DIAG2=$(curl -s -m 60 "$CELL/kortix/diag" "${AH[@]}")
ck "and the cell reports itself attached to THAT box — the same id the control plane names" \
  "$(D="$DIAG2" I="$ENVID" python3 -c 'import json,os
try: d=json.loads(os.environ["D"]); print(1 if os.environ["I"] and d.get("environment")==os.environ["I"] else 0)
except Exception: print(0)')" "diag.environment=$(printf '%s' "$DIAG2" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("environment"))' 2>/dev/null) api=$ENVID"

wait $PUMP 2>/dev/null || true
# ---------- 7. what the stream carried ----------
echo "  --- stream:"
grep -oE 'event: [a-z.]+' /tmp/de2e.log | sort | uniq -c | sort -rn | head -8 | sed 's/^/    /'
DELTAS=$(grep -c 'event: message.part.delta' /tmp/de2e.log 2>/dev/null | head -1); DELTAS=${DELTAS:-0}
DOWN=$(grep -c '"state":"down"' /tmp/de2e.log 2>/dev/null | head -1); DOWN=${DOWN:-0}
ck "the stream carried incremental text, not one lump at the end" \
  "$([ "$DELTAS" -gt 5 ] && echo 1 || echo 0)" "$DELTAS delta frames"
ck "and the runtime channel never announced itself down" \
  "$([ "$DOWN" = 0 ] && echo 1 || echo 0)" "$DOWN down frames"
SIDS=$(grep -oE '"sessionID":"[^"]+"' /tmp/de2e.log | sort -u | sed 's/.*://;s/"//g' | tr '\n' ' ')
ck "every frame named THIS session" \
  "$([ "$(printf '%s' "$SIDS" | tr -d ' ')" = "$SID" ] && echo 1 || echo 0)" "saw: $SIDS"

# ---------- 8. the bundle again, now that turns have happened ----------
BUN2=$(curl -s -m 60 "$BASE/v1/projects/$PROJ/sessions/$SID/open-bundle" "${AH[@]}")
echo "$BUN2" | python3 -c '
import json,sys;d=json.load(sys.stdin);r=d.get("runtime") or {}
st=r.get("state") or {}
print("   bundle now: runtime known=%s fresh=%s sections=%s" % (r.get("known"), r.get("fresh"), len(st)))'
ck "after a turn the session open carries a real runtime, not no_projection" \
  "$(printf '%s' "$BUN2" | python3 -c 'import json,sys;r=(json.load(sys.stdin).get("runtime") or {});print(1 if r.get("known") else 0)')" \
  "$(printf '%s' "$BUN2" | python3 -c 'import json,sys;print((json.load(sys.stdin).get("runtime") or {}).get("reason"))')"

# ---------- 9. the transcript holds every exchange ----------
TX=$(curl -s -m 60 "$BASE/v1/projects/$PROJ/sessions/$SID/transcript?limit=50" "${AH[@]}")
echo "$TX" | python3 -c '
import json,sys;m=json.load(sys.stdin).get("messages",[])
roles=[x.get("role") for x in m]
print("   transcript: %d messages  %s" % (len(m), ",".join(roles[:10])))'
ck "the transcript holds all four exchanges, in order" \
  "$(printf '%s' "$TX" | python3 -c '
import json,sys
m=json.load(sys.stdin).get("messages",[])
u=[x for x in m if x.get("role")=="user"]; a=[x for x in m if x.get("role")=="assistant" and (x.get("text") or "").strip()]
print(1 if len(u)>=4 and len(a)>=4 else 0)')" \
  "$(printf '%s' "$TX" | python3 -c 'import json,sys;m=json.load(sys.stdin).get("messages",[]);print(len(m),"messages")')"

# THE MACHINE IS A MICROVM ON THE DEV HOST, and this suite made one. Stopped
# here rather than left for the hour-long idle timer: three of them from one
# afternoon's runs held 6 GB of a 32 GB host and every later suite that needed
# a cell answered "could not create a cell sandbox" (2026-09-11). A stopped
# environment resumes on its next ensure, so nothing is lost by stopping it.
curl -s -m 90 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/environment/stop" "${AH[@]}" -d '{}' || true
echo
echo "  legs (ms): create $((TC-T0))  ready $((TR-TC))  bundle $((TB-TR))  answer1 $((TA1-TP1))  answer2 $((TA2-TP2))  tool-turn $((TA3-TP3))  read-back $((TA4-TP4))  machine $((TA6-TP6))"
echo "  a session, end to end: $PASS passed, $FAIL failed"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
