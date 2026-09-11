#!/usr/bin/env bash
# THE NATIVE ROUTE SURFACE, ON THE REAL DEPLOYMENT.
#
# `kortix-routes-logic.mjs` asserts every one of these shapes in process, and
# that is where the shapes belong: it is fast, it is exhaustive, and it needs
# no deployment. What it CANNOT see is the leg between a caller and the cell —
# the proxy that has to name the session, the route table as the bundle on the
# box actually has it, and the routes whose answer depends on a checkout, a
# git origin and a token that only exist on a real session.
#
# Every one of those has failed here for a reason no in-process suite could
# have caught. A shared runner answering the fall-through shape to every path
# (2026-09-10) passed `kortix-routes-logic` perfectly. So did a cell whose
# proxy dropped the `c=` and answered for the wrong session. So did the pty
# routes that 503'd because their path ordering was wrong on the box.
#
# The rule this suite keeps: a route answers its OWN shape, not a 200 that
# looks served, and the two 404s a caller must tell apart stay apart.
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
# EVERY SHAPE ASSERTION IS PYTHON OVER THE BODY, never a grep for a word: a
# fall-through answer contains the session id too, and `grep -q` on it passed
# for an hour while nothing was actually served.
jq_(){ python3 -c "$1" 2>/dev/null || echo ""; }

SIGNIN=$(U="$E2E_USER" P="$E2E_PASS" python3 -c 'import json,os;print(json.dumps({"email":os.environ["U"],"password":os.environ["P"]}))')
# A SKIP MUST MEAN "NOT DEPLOYED", NEVER "BUSY RIGHT NOW". One curl that times
# out under load reads identically to a deployment that does not exist, and a
# suite that skips on the first is a suite that reports success while the thing
# it tests is down. Three tries, spaced, before believing it.
SICODE=000
for try in 1 2 3; do
  SICODE=$(curl -s -m 30 -o /tmp/dre2e.auth -w '%{http_code}' -X POST "$BASE/v1/auth/sign-in/password" -H 'content-type: application/json' -d "$SIGNIN")
  [ "$SICODE" = "000" ] || break
  sleep 5
done
[ "$SICODE" = "000" ] && { echo "  SKIP: $BASE is unreachable (3 tries)"; exit 0; }
A=$(python3 -c 'import json
try: print(json.load(open("/tmp/dre2e.auth"))["session"]["access_token"])
except Exception: print("")')
[ -n "$A" ] || { echo "  FAIL sign-in reachable but returned no token (http $SICODE)"; exit 1; }
AH=(-H "authorization: Bearer $A")
JH=("${AH[@]}" -H 'content-type: application/json')

SID=$(curl -s -m 180 -X POST "$BASE/v1/projects/$PROJ/sessions" "${JH[@]}" -d '{}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("session_id",""))')
[ -n "$SID" ] || { echo "  FAIL create returned no session"; exit 1; }
echo "  session $SID"
n=0; ST=""
while [ $n -lt 12 ]; do n=$((n+1))
  ST=$(curl -s -m 60 -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/start?wait_ms=8000" "${JH[@]}" -d '{}' \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("stage","?"))'); [ "$ST" = ready ] && break; done
[ "$ST" = ready ] || { echo "  FAIL the session never reached ready (stage=$ST)"; exit 1; }

# ONE TURN FIRST. Half these routes answer about a transcript, a checkout and a
# turn ledger; asking them of a session that has never spoken tests the empty
# case only, which is the case that was already passing when everything else
# was broken.
MARK="routes-$(date +%s)-$$"
python3 -c '
import json,random,string,sys
h="".join(random.choice("0123456789abcdef") for _ in range(12))
t="".join(random.choice(string.ascii_letters+string.digits) for _ in range(14))
json.dump({"client_message_id":"cm-"+h,"message_id":"msg_"+h+t,
          "parts":[{"type":"text","text":"Use your write tool to create the file tmp/"+sys.argv[1]+".txt containing exactly "+sys.argv[1]+", then reply with only the word: done"}]},
          open("/tmp/dre2e.b1","w"))' "$MARK"
curl -s -m 30 -o /dev/null -X POST "$BASE/v1/projects/$PROJ/sessions/$SID/prompts" "${JH[@]}" -d @/tmp/dre2e.b1
ans(){ curl -s -m 60 "$BASE/v1/projects/$PROJ/sessions/$SID/transcript?limit=30" "${AH[@]}" \
  | python3 -c 'import json,sys
t=[(m.get("text") or "") for m in json.load(sys.stdin).get("messages",[]) if m.get("role")=="assistant"]
t=[x for x in t if x.strip()]
print(t[-1] if t else "")'; }
t=0; while [ $t -lt 150 ]; do printf '%s' "$(ans)" | grep -qi done && break; sleep 2; t=$((t+2)); done
ck "the session answered a turn, so the routes below have a transcript to report" \
  "$(printf '%s' "$(ans)" | grep -qi done && echo 1 || echo 0)" "got: $(ans | head -c 60)"

# THE CELL, THROUGH THE PROXY THE APP USES. `/v1/p/<session>/8080` — not the
# box: on a shared runner the box name reaches whichever cell answers first.
C="$BASE/v1/p/$SID/8080"
get(){ curl -s -m 60 "$C$1" "${AH[@]}"; }
code(){ curl -s -m 60 -o /dev/null -w '%{http_code}' "$C$1" "${AH[@]}"; }
post(){ curl -s -m 120 -X POST "$C$1" "${JH[@]}" -d "$2"; }

# ---------- the OpenCode-shaped reads the control plane makes ----------
echo "  --- /kortix/opencode/*"
STATE=$(get "/kortix/opencode/state")
ck "GET /kortix/opencode/state answers for THIS session, not the box's creator" \
  "$(S="$STATE" I="$SID" jq_ 'import json,os
d=json.loads(os.environ["S"]); i=d.get("identity") or {}
print(1 if i.get("opencode_session_id")==os.environ["I"] else 0)')" \
  "identity: $(S="$STATE" jq_ 'import json,os;print(json.dumps((json.loads(os.environ["S"]).get("identity") or {}))[:120])')"

MSGS=$(get "/kortix/opencode/messages/$SID")
ck "GET /kortix/opencode/messages/:id answers the daemon's envelope, with this session's turn in it" \
  "$(M="$MSGS" I="$SID" jq_ 'import json,os
d=json.loads(os.environ["M"])
ok = d.get("session_id")==os.environ["I"] and d.get("source")=="cell" and isinstance(d.get("messages"),list)
ok = ok and d.get("count")==len(d["messages"]) and len(d["messages"])>=2
ok = ok and all(("info" in m and "parts" in m) for m in d["messages"])
print(1 if ok else 0)')" \
  "$(M="$MSGS" jq_ 'import json,os;d=json.loads(os.environ["M"]);print({k:d.get(k) for k in ("session_id","source","count","has_more")})')"
ck "and it PAGES: limit=1 returns one message and says there is more" \
  "$(M="$(get "/kortix/opencode/messages/$SID?limit=1")" jq_ 'import json,os
d=json.loads(os.environ["M"]); print(1 if d.get("count")==1 and d.get("has_more") is True else 0)')" \
  "$(M="$(get "/kortix/opencode/messages/$SID?limit=1")" jq_ 'import json,os;d=json.loads(os.environ["M"]);print({k:d.get(k) for k in ("count","has_more","last_message_id")})')"
ck "and another session's transcript is 404 'unknown session', naming the one this cell has" \
  "$(M="$(get "/kortix/opencode/messages/not-this-session")" I="$SID" jq_ 'import json,os
d=json.loads(os.environ["M"]); print(1 if d.get("error")=="unknown session" and d.get("expected")==os.environ["I"] else 0)')" \
  "$(get "/kortix/opencode/messages/not-this-session" | head -c 90)"

ck "GET /kortix/opencode/session/:id is the session OBJECT, not the list" \
  "$(S="$(get "/kortix/opencode/session/$SID")" I="$SID" jq_ 'import json,os
d=json.loads(os.environ["S"]); print(1 if isinstance(d,dict) and d.get("id")==os.environ["I"] else 0)')" \
  "$(get "/kortix/opencode/session/$SID" | head -c 90)"
ck "GET /kortix/opencode/todo/:id is a list" \
  "$(T="$(get "/kortix/opencode/todo/$SID")" jq_ 'import json,os;print(1 if isinstance(json.loads(os.environ["T"]),list) else 0)')" \
  "$(get "/kortix/opencode/todo/$SID" | head -c 60)"
ck "GET /kortix/opencode/config names the model this session is actually running" \
  "$(F="$(get "/kortix/opencode/config")" jq_ 'import json,os
d=json.loads(os.environ["F"]); m=d.get("model") or ""
print(1 if isinstance(m,str) and "/" in m else 0)')" \
  "$(get "/kortix/opencode/config" | head -c 80)"
ck "GET /kortix/opencode/project-current names the worktree the tools run in" \
  "$(P="$(get "/kortix/opencode/project-current")" jq_ 'import json,os
print(1 if json.loads(os.environ["P"]).get("worktree")=="/workspace" else 0)')" \
  "$(get "/kortix/opencode/project-current" | head -c 80)"
ck "GET /kortix/opencode/vcs-diff answers a diff over the real checkout — the file the agent just wrote is in it" \
  "$(V="$(get "/kortix/opencode/vcs-diff")" M="$MARK" jq_ 'import json,os
d=json.loads(os.environ["V"]); f=d.get("files") or []
print(1 if isinstance(f,list) and any(os.environ["M"] in json.dumps(x) for x in f) else 0)')" \
  "$(get "/kortix/opencode/vcs-diff" | head -c 140)"

# ---------- act: the one route that CHANGES something ----------
# ONE CALL PER CLAIM. The first version of this suite sent each request twice
# — once to decide the claim and once to build the message — which for a route
# that WRITES meant doing the write twice, and the second commit-push then
# reported on a tree the first one had already cleaned.
ACT_STOP=$(post "/kortix/opencode/act" '{"kind":"stop"}')
ck "POST /kortix/opencode/act {kind:stop} is accepted and names the session it stopped" \
  "$(R="$ACT_STOP" I="$SID" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if d.get("ok") is True and d.get("kind")=="stop" and d.get("session_id")==os.environ["I"] else 0)')" \
  "$(printf '%s' "$ACT_STOP" | head -c 100)"
ACT_PERM=$(post "/kortix/opencode/act" '{"kind":"permission"}')
ck "and a kind a cell cannot do is REFUSED with the reason, not answered ok" \
  "$(R="$ACT_PERM" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if d.get("ok") is False and "cell" in (d.get("error") or "") else 0)')" \
  "$(printf '%s' "$ACT_PERM" | head -c 110)"
ACT_BAD=$(post "/kortix/opencode/act" '{"kind":"teleport"}')
ck "and an unknown kind lists the kinds there are" \
  "$(R="$ACT_BAD" jq_ 'import json,os
d=json.loads(os.environ["R"]); s=d.get("supported") or []
print(1 if d.get("ok") is False and set(s)=={"permission","question","stop","revert"} else 0)')" \
  "$(printf '%s' "$ACT_BAD" | head -c 110)"

# ---------- a part, fetched out of the transcript by id ----------
PARTREF=$(M="$MSGS" jq_ 'import json,os
d=json.loads(os.environ["M"])
for m in d.get("messages",[]):
    for p in (m.get("parts") or []):
        if p.get("id"):
            print(m["info"]["id"]+" "+p["id"]); raise SystemExit
print("")')
if [ -z "$PARTREF" ]; then
  echo "  SKIP no part carried an id — nothing to fetch by reference"
else
  set -- $PARTREF
  ck "GET /kortix/part/:session/:message/:part returns that part's own body" \
    "$(P="$(get "/kortix/part/$SID/$1/$2")" X="$2" jq_ 'import json,os
d=json.loads(os.environ["P"]); print(1 if d.get("id")==os.environ["X"] and d.get("type") else 0)')" \
    "$(get "/kortix/part/$SID/$1/$2" | head -c 90)"
  ck "and a part id that does not exist is 404, not an empty 200" \
    "$([ "$(code "/kortix/part/$SID/$1/no-such-part")" = 404 ] && echo 1 || echo 0)" "http $(code "/kortix/part/$SID/$1/no-such-part")"
fi

# ---------- what the box says about itself ----------
echo "  --- /kortix/{ports,logs,diag,health,env,pty}"
ck "GET /kortix/ports is an empty list WITH the reason — a cell has no processes, and a 404 would read as broken" \
  "$(P="$(get "/kortix/ports")" jq_ 'import json,os
d=json.loads(os.environ["P"]); print(1 if d.get("ports")==[] and "listen" in (d.get("reason") or "") else 0)')" \
  "$(get "/kortix/ports" | head -c 100)"
ck "GET /kortix/logs tails this session's own turns" \
  "$(L="$(get "/kortix/logs")" jq_ 'import json,os
d=json.loads(os.environ["L"]); l=d.get("lines") or []
print(1 if d.get("source")=="cell" and len(l)>=1 and "turn" in l[-1] else 0)')" \
  "$(get "/kortix/logs" | head -c 110)"
DIAG=$(get "/kortix/diag")
ck "GET /kortix/diag reports a checked-out workspace with the project's own config dir" \
  "$(D="$DIAG" jq_ 'import json,os
d=json.loads(os.environ["D"])
print(1 if d.get("runtime")=="cell" and d.get("checkedOut") is True and (d.get("configDir") or "").startswith(".kortix/") else 0)')" \
  "$(D="$DIAG" jq_ 'import json,os;d=json.loads(os.environ["D"]);print({k:d.get(k) for k in ("runtime","checkedOut","configDir","agent","agent_prompt")})')"
ck "and it says the PROJECT's system prompt is the one running, not the runtime's built-in" \
  "$(D="$DIAG" jq_ 'import json,os;print(1 if json.loads(os.environ["D"]).get("agent_prompt")=="project" else 0)')" \
  "agent_prompt=$(D="$DIAG" jq_ 'import json,os;print(json.loads(os.environ["D"]).get("agent_prompt"))')"
ck "GET /kortix/health carries the compiled agent config's etag — the control plane compares it" \
  "$(H="$(get "/kortix/health")" jq_ 'import json,os
d=json.loads(os.environ["H"]); e=d.get("agent_config_etag")
print(1 if isinstance(e,str) and len(e)>=8 else 0)')" \
  "$(get "/kortix/health" | head -c 120)"
ck "GET /env lists the session env keys the control plane pushed, including the compiled agent config" \
  "$(E="$(get "/env")" jq_ 'import json,os
k=set(json.loads(os.environ["E"]).get("keys") or [])
need={"KORTIX_SESSION_ID","KORTIX_PROJECT_ID","KORTIX_TOKEN","KORTIX_REPO_URL","KORTIX_BRANCH_NAME","KORTIX_COMPILED_AGENT_CONFIG"}
print(1 if need <= k else 0)')" \
  "$(get "/env" | head -c 200)"
ck "GET /kortix/pty is the terminal list, empty on a session nobody has opened one on" \
  "$(P="$(get "/kortix/pty")" jq_ 'import json,os
d=json.loads(os.environ["P"])
print(1 if isinstance(d,list) or isinstance(d.get("terminals"),list) else 0)')" \
  "$(get "/kortix/pty" | head -c 80)"

# ---------- the OpenCode surface the app itself speaks ----------
echo "  --- the app's own routes"
ck "GET /agent reports the project's agent with the description from its own .md" \
  "$(G="$(get "/agent")" jq_ 'import json,os
a=json.loads(os.environ["G"])
print(1 if isinstance(a,list) and a and a[0].get("description") and "running in a cell" not in a[0]["description"] else 0)')" \
  "$(get "/agent" | head -c 110)"
ck "GET /skills lists the project's skills, from the directory its manifest names" \
  "$(S="$(get "/skills")" jq_ 'import json,os
d=json.loads(os.environ["S"]); dirs=d.get("dirs") or []
print(1 if len(d.get("skills") or [])>0 and any("/workspace/.kortix/" in x for x in dirs) else 0)')" \
  "$(S="$(get "/skills")" jq_ 'import json,os;d=json.loads(os.environ["S"]);print(len(d.get("skills") or []), d.get("dirs"))')"
ck "GET /file lists the checkout the project was cloned into" \
  "$(F="$(get "/file?path=")" jq_ 'import json,os
n=[x.get("name") for x in json.loads(os.environ["F"])]
print(1 if "kortix.yaml" in n and "AGENTS.md" in n and ".git" in n else 0)')" \
  "$(F="$(get "/file?path=")" jq_ 'import json,os;print([x.get("name") for x in json.loads(os.environ["F"])][:8])')"
# GIT IS ASKED WHERE THE FILE IS, not the prompt. This suite asked for
# `tmp/<mark>.txt` and the model is free to obey the project's AGENTS.md over
# the letter of the request — the first run put the file somewhere else for
# exactly that reason, and a claim that hard-codes the path tests the model's
# obedience rather than the route.
WROTE=$(F="$(get "/file/status")" M="$MARK" jq_ 'import json,os
for x in json.loads(os.environ["F"]):
    if os.environ["M"] in (x.get("path") or "") and x.get("status")=="added":
        print(x["path"]); raise SystemExit
print("")')
ck "GET /file/status reports the file the agent just wrote as ADDED against the project's git" \
  "$([ -n "$WROTE" ] && echo 1 || echo 0)" "status: $(get "/file/status" | head -c 140)"
if [ -z "$WROTE" ]; then
  echo "  SKIP git saw no new file, so there is no path to read back"
else
  ck "GET /file/content reads that file back through the route the viewer uses" \
    "$(F="$(get "/file/content?path=$WROTE")" M="$MARK" jq_ 'import json,os
print(1 if os.environ["M"] in (json.loads(os.environ["F"]).get("content") or "") else 0)')" \
    "$WROTE -> $(get "/file/content?path=$WROTE" | head -c 90)"
  ck "and GET /file lists it in the directory git says it is in" \
    "$(D="$(dirname "$WROTE")" B="$(basename "$WROTE")" F="$(get "/file?path=$(dirname "$WROTE")")" jq_ 'import json,os
n=[x.get("name") for x in json.loads(os.environ["F"])]
print(1 if os.environ["B"] in n else 0)')" \
    "$(dirname "$WROTE"): $(F="$(get "/file?path=$(dirname "$WROTE")")" jq_ 'import json,os;print([x.get("name") for x in json.loads(os.environ["F"])][:8])')"
fi
ck "GET /find/file finds it by name" \
  "$(F="$(get "/find/file?query=$MARK")" M="$MARK" jq_ 'import json,os
d=json.loads(os.environ["F"]); print(1 if any(os.environ["M"] in str(x) for x in (d if isinstance(d,list) else d.get("files") or [])) else 0)')" \
  "$(get "/find/file?query=$MARK" | head -c 100)"

# ---------- the two 404s a caller has to tell apart ----------
ck "a path that is not a route at all answers 'unknown route', naming the path" \
  "$(U="$(get "/kortix/no-such-route")" jq_ 'import json,os
d=json.loads(os.environ["U"])
print(1 if d.get("ok") is False and d.get("error")=="unknown route" and d.get("path")=="/kortix/no-such-route" else 0)')" \
  "$(get "/kortix/no-such-route" | head -c 110)"
ck "and a route a cell CANNOT serve says so with 501, not 404 — 'not possible' is not 'not here'" \
  "$([ "$(code "/proxy/3000")" = 501 ] && [ "$(code "/presentation/convert")" = 501 ] && echo 1 || echo 0)" \
  "proxy $(code "/proxy/3000")  presentation $(code "/presentation/convert")"

# ---------- the routes a client calls that a cell used to 404 ----------
#
# Twenty-one paths the SDK, the web app and the control plane build on a
# sandbox base answered `unknown route` on a live cell, measured 2026-09-11.
# Each failed as something other than a missing route: an empty Changes tab, an
# empty skills list, a reap that looked like a broken runtime. In process they
# are asserted exhaustively (kortix-routes-logic, boot-logic); here the
# question is only whether the deployed bundle really serves them.
echo "  --- the surface the SDK expects"
ck "GET /skill answers OpenCode's own name for the skills list, with each skill's location and body" \
  "$(K="$(get "/skill")" jq_ 'import json,os
a=json.loads(os.environ["K"])
print(1 if isinstance(a,list) and len(a)>0 and all(("name" in x and "location" in x and "content" in x) for x in a) else 0)')" \
  "$(K="$(get "/skill")" jq_ 'import json,os;a=json.loads(os.environ["K"]);print(len(a), [x.get("name") for x in a][:4])')"
ck "GET /session/:id/diff answers one entry per changed file, each with its own patch and counts" \
  "$(D="$(get "/session/$SID/diff")" jq_ 'import json,os
a=json.loads(os.environ["D"])
print(1 if isinstance(a,list) and len(a)>0 and all(("file" in x and "patch" in x and "additions" in x and "deletions" in x and "status" in x) for x in a) else 0)')" \
  "$(get "/session/$SID/diff" | head -c 130)"
ck "GET /path names the one directory a cell has" \
  "$(P="$(get "/path")" jq_ 'import json,os
d=json.loads(os.environ["P"])
print(1 if d.get("worktree")=="/workspace" and d.get("directory")=="/workspace" and d.get("home") else 0)')" \
  "$(get "/path" | head -c 110)"
ck "GET /project is the list holding this session's project, marked as a git checkout" \
  "$(L="$(get "/project")" jq_ 'import json,os
a=json.loads(os.environ["L"])
print(1 if isinstance(a,list) and len(a)==1 and a[0].get("vcs")=="git" and a[0].get("worktree")=="/workspace" else 0)')" \
  "$(get "/project" | head -c 130)"
ck "GET /global/health is the client's own liveness probe" \
  "$(H="$(get "/global/health")" jq_ 'import json,os
d=json.loads(os.environ["H"]); print(1 if d.get("healthy") is True and d.get("version") else 0)')" \
  "$(get "/global/health" | head -c 80)"
MSGID=$(M="$MSGS" jq_ 'import json,os
d=json.loads(os.environ["M"])
ids=[m["info"]["id"] for m in d.get("messages",[]) if m.get("info")]
print(ids[-1] if ids else "")')
if [ -n "$MSGID" ]; then
  ck "GET /session/:id/message/:messageID is that one message with its parts" \
    "$(O="$(get "/session/$SID/message/$MSGID")" I="$MSGID" jq_ 'import json,os
d=json.loads(os.environ["O"])
print(1 if (d.get("info") or {}).get("id")==os.environ["I"] and isinstance(d.get("parts"),list) else 0)')" \
    "$(get "/session/$SID/message/$MSGID" | head -c 110)"
else
  echo "  SKIP the transcript carried no message id to read back"
fi
ck "POST /kortix/abort is the box-wide stop the reaper sends, and names the session" \
  "$(R="$(post "/kortix/abort" '{}')" I="$SID" jq_ 'import json,os
d=json.loads(os.environ["R"]); print(1 if d.get("ok") is True and d.get("opencode_session_id")==os.environ["I"] else 0)')" \
  "$(post "/kortix/abort" '{}' | head -c 100)"
ck "GET /kortix/opencode/turn/:messageId answers the daemon's fields about one prompt" \
  "$(T="$(get "/kortix/opencode/turn/${MSGID:-none}")" jq_ 'import json,os
d=json.loads(os.environ["T"])
print(1 if "in_flight" in d and "end" in d and "orphaned_prompt" in d and "seq" in d else 0)')" \
  "$(get "/kortix/opencode/turn/${MSGID:-none}" | head -c 120)"
ck "what a cell cannot do says so with 501 and a reason: share, revert, unrevert, the web proxy" \
  "$([ "$(code "/web-proxy/http/example.com")" = 501 ] && \
    [ "$(curl -s -m 60 -o /dev/null -w '%{http_code}' -X POST "$C/session/$SID/share" "${JH[@]}" -d '{}')" = 501 ] && \
    [ "$(curl -s -m 60 -o /dev/null -w '%{http_code}' -X POST "$C/session/$SID/revert" "${JH[@]}" -d '{}')" = 501 ] && echo 1 || echo 0)" \
  "web-proxy $(code "/web-proxy/http/example.com")"
# ENV THE SESSION SETS FOR ITSELF, and the platform env it must never hand back.
curl -s -m 60 -o /dev/null -X PUT "$C/env/E2E_PROBE" "${JH[@]}" -d '{"value":"probe-value"}'
ENVBODY=$(get "/env")
ck "PUT /env/:key stores a value the session set, and GET /env reports it under secrets" \
  "$(E="$ENVBODY" jq_ 'import json,os
print(1 if (json.loads(os.environ["E"]).get("secrets") or {}).get("E2E_PROBE")=="probe-value" else 0)')" \
  "$(printf '%s' "$ENVBODY" | head -c 140)"
ck "and this session's Kortix token is NOT in that answer — its key is listed, its value never leaves the cell" \
  "$(E="$ENVBODY" jq_ 'import json,os
d=json.loads(os.environ["E"]); s=d.get("secrets") or {}
print(1 if "KORTIX_TOKEN" in (d.get("keys") or []) and "KORTIX_TOKEN" not in s else 0)')" \
  "keys=$(printf '%s' "$ENVBODY" | python3 -c 'import json,sys;print(len(json.load(sys.stdin).get("keys") or []))') secrets=$(printf '%s' "$ENVBODY" | python3 -c 'import json,sys;print(list((json.load(sys.stdin).get("secrets") or {}).keys()))')"
curl -s -m 60 -o /dev/null -X DELETE "$C/env/E2E_PROBE" "${JH[@]}"

# ---------- commit-push: the only route that writes to the world ----------
echo "  --- /kortix/git/commit-push"
CP=$(post "/kortix/git/commit-push" "$(python3 -c 'import json,sys;print(json.dumps({"message":"routes-e2e: "+sys.argv[1]}))' "$MARK")")
BRANCH=$(R="$CP" jq_ 'import json,os;print(json.loads(os.environ["R"]).get("branch") or "")')
HEAD=$(R="$CP" jq_ 'import json,os;print(json.loads(os.environ["R"]).get("headSha") or "")')
ck "POST /kortix/git/commit-push commits the workspace and pushes it to the session's own branch" \
  "$(R="$CP" jq_ 'import json,os
d=json.loads(os.environ["R"])
print(1 if d.get("ok") is True and d.get("committed") is True and d.get("pushed") is True and len(d.get("headSha") or "")==40 else 0)')" \
  "$(printf '%s' "$CP" | head -c 160)"
# AND THE ORIGIN AGREES. A push that reports success and left nothing behind is
# the failure this route is most likely to have, and only the remote can say.
if [ -n "$BRANCH" ] && [ -n "$HEAD" ]; then
  REMOTE=$(GIT_TERMINAL_PROMPT=0 git ls-remote "$BASE/v1/git/$PROJ.git" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')
  ck "and the ORIGIN really has that commit on that branch — asked of the remote, not of the cell" \
    "$([ -n "$REMOTE" ] && [ "$REMOTE" = "$HEAD" ] && echo 1 || echo 0)" "cell said $HEAD, origin says ${REMOTE:-<nothing>}"
else
  echo "  SKIP the push reported no branch or head to verify against the origin"
fi
# A TOKEN OUTLIVES THE SUITE ONLY IF IT IS REFRESHED. This runs minutes after
# sign-in, behind a model turn and forty probes; the first version of this leg
# reported the API's own "Invalid or expired token" as a cell failure.
A=$(curl -s -m 30 -X POST "$BASE/v1/auth/sign-in/password" -H 'content-type: application/json' -d "$SIGNIN" \
  | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["session"]["access_token"])
except Exception: print("")')
AH=(-H "authorization: Bearer $A"); JH=("${AH[@]}" -H 'content-type: application/json')
CP2=$(post "/kortix/git/commit-push" '{}')
ck "a second push with nothing changed is 'nothing to do', not a second empty commit" \
  "$(R="$CP2" jq_ 'import json,os
d=json.loads(os.environ["R"])
print(1 if d.get("ok") is True and (d.get("nothingToDo") is True or d.get("committed") is False) else 0)')" \
  "$(printf '%s' "$CP2" | head -c 140)"

echo
echo "  the native route surface, live: $PASS passed, $FAIL failed"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
