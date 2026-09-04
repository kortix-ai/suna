#!/usr/bin/env bash
# PI-IN-A-CELL, END TO END, ON A REAL CELLD NODE.
#
# Not a mock and not miniflare: the pinned celld 0.3.0 binary from
# infra/celld/pt-celld.spec.json, a real S3 (MinIO), a real deployment through
# `celld deploy`, and a real V8 isolate with real SQLite.
#
# Five claims, in the order they build on each other. Each one FAILS LOUDLY
# rather than warning, because a durability test that degrades to a warning is
# how you end up believing something you never measured:
#
#   1. the agent bundle loads and serves inside a cell
#   2. a prompt drives pi's loop to a tool call, which reaches a real shell
#   3. the transcript is in the cell's own SQLite, in pi's message shape
#   4. replaying a toolCallId does NOT re-execute the command
#   5. SIGKILL the node, start a new process, and the transcript comes back
#
# (5) is the one that matters: it is "a session survives the death of the thing
# running it", which is the entire reason to put an agent in a cell.
set -euo pipefail

# FREE A PORT WITHOUT KILLING THE MACHINE'S DOCKER.
#
# This was `lsof -ti tcp:7098 | xargs kill -9`, and it SIGKILLed OrbStack once
# per sweep. `lsof -ti tcp:PORT` lists every process with a socket on that port,
# INCLUDING THE FAR END: the cell runs inside the VM and dials
# host.docker.internal:7098, so OrbStack proxies it and holds an ESTABLISHED
# socket there, right next to our stub's LISTEN. `xargs kill -9` killed both.
# Only listeners, and only something we would recognise as ours.
free_port() {
  for p in $(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null); do
    case "$(ps -o comm= -p "$p" 2>/dev/null)" in *node*) kill -9 "$p" 2>/dev/null || true ;; esac
  done
}
cd "$(dirname "$0")/.."

# Pin the model to the scripted one for the whole run. Without this the suite
# uses whatever agent.config.json points at, so the moment anyone logs in to a
# real provider these claims stop being deterministic and start costing money.
export PT_AGENT_SCRIPTED=1

BUCKET=${BUCKET:-cells}
PREFIX=${PREFIX:-orgs/demo}
MINIO_PORT=${MINIO_PORT:-19000}
CELL_PORT=${CELL_PORT:-18080}
DAEMON_PORT=${DAEMON_PORT:-7070}
TOKEN=${TOKEN:-dev-token}
# STABLE, because celld routes a cell to its OWNER by node id. A node that comes
# back with a fresh identity is not the owner, and every request to that cell
# answers `DurableObjectRoutingError: The Durable Object owner is currently
# unreachable` until the old lease expires. Measured the hard way; it is the same
# hazard celld-boot.sh calls "the 36x one".
NODE_ID=${NODE_ID:-agent-node-0}
SESSION=e2e-$$

PASSED=0
pass() { PASSED=$((PASSED+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

cleanup() {
  node celldctl.mjs down >/dev/null 2>&1 || true
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true
  free_port 7098
}
trap cleanup EXIT

cell()   { curl -s -m 60 "http://127.0.0.1:${CELL_PORT}$1" "${@:2}"; }
daemon() { curl -s -m 20 "http://127.0.0.1:${DAEMON_PORT}$1" -H "authorization: Bearer ${TOKEN}" "${@:2}"; }
# strict=False: tool output carries raw newlines inside JSON strings, which JS
# accepts and Python's strict parser does not. The data is fine.
pyjson()  { python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False);$1"; }

# The container name and every celld flag come from agent.config.json via
# celldctl. This used to duplicate the docker line, which meant the suite ran a
# DIFFERENT node from the one celldctl manages: both wanted port 18080, the
# second lost, and the health check passed against the survivor. The suite then
# tested a deployment it had not made. celldctl catches that now, but the real
# fix is to stop having two launch paths.
CONTAINER=pt-cell-$(python3 -c "import json;print(json.load(open('agent.config.json'))['name'])")
start_cell() { node celldctl.mjs up >/dev/null 2>&1; }

echo "== setup =="
docker inspect pt-minio >/dev/null 2>&1 || {
  # Bounded for the same reason as the cell node: nothing this suite starts
  # should be able to take the host's memory.
  docker run -d --name pt-minio -p "${MINIO_PORT}:9000" --memory 512m --memory-swap 512m \
    -e MINIO_ROOT_USER=celldev -e MINIO_ROOT_PASSWORD=celldev123 \
    quay.io/minio/minio server /data >/dev/null
  sleep 3
}
docker start pt-minio >/dev/null 2>&1 || true
docker run --rm --network host --entrypoint sh quay.io/minio/mc -c \
  "mc alias set m http://127.0.0.1:${MINIO_PORT} celldev celldev123 >/dev/null 2>&1 && mc mb -p m/${BUCKET} >/dev/null 2>&1 || true" >/dev/null 2>&1


# celldctl owns the daemon too (it claims the port first, so a leftover daemon
# with a different work root cannot answer for it).
rm -rf /tmp/agent-cell-work

echo "== 1. the cell serves the agent bundle =="
start_cell || fail "cell never became healthy"
cell /health | grep -q 'pi-in-a-cell' && pass "agent worker is live inside celld" || fail "wrong worker served"

# A SECOND `up` MUST NOT RESTART THE NODE.
#
# Restarts are the operation this machine's Docker VM keeps dying under, and
# every suite calls `up`. The skip is claimed as a pure function in
# celldctl-logic — five terms, seven ways it must NOT skip — but nothing checked
# that the whole thing actually leaves the container alone, which is the only
# form of the claim that protects the VM.
#
# Free to test: the node is already up, and this adds no restart.
STARTED_BEFORE=$(docker inspect -f '{{.State.StartedAt}}' "$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)" 2>/dev/null)
SKIP_SAID=$(node celldctl.mjs up 2>&1 | tail -1)
STARTED_AFTER=$(docker inspect -f '{{.State.StartedAt}}' "$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)" 2>/dev/null)
[ -n "$STARTED_BEFORE" ] && [ "$STARTED_BEFORE" = "$STARTED_AFTER" ] \
  && pass "a second up left the node running (started ${STARTED_BEFORE#*T})" \
  || fail "up restarted a node that was already serving this bundle: ${STARTED_BEFORE} -> ${STARTED_AFTER}"
case "$SKIP_SAID" in
  *"not restarting"*) pass "and said why, rather than restarting silently" ;;
  *) fail "up did not report the skip: ${SKIP_SAID}" ;;
esac

echo "== 2. a prompt reaches a real shell =="
cell "/prompt?c=${SESSION}" -X POST -H 'content-type: application/json' -d '{"text":"go"}' >/dev/null
PROOF=$(cat "/tmp/agent-cell-work/${SESSION}/proof.txt" 2>/dev/null || echo "")
[ "$PROOF" = "AGENT_RAN_42" ] \
  && pass "the tool ran a real command (proof.txt = $PROOF)" \
  || fail "no shell side effect; got '${PROOF}'"

echo "== 3. the transcript is in the cell's SQLite, in pi's shape =="
ROLES=$(cell "/history?c=${SESSION}" | pyjson "print(','.join(m['role'] for m in d['messages']))")
[ "$ROLES" = "user,assistant,toolResult,assistant" ] \
  && pass "transcript is user,assistant,toolResult,assistant" \
  || fail "unexpected transcript: ${ROLES}"

echo "== 4. replaying a toolCallId does not re-execute =="
RUNS_BEFORE=$(daemon /_ops | pyjson "print(sum(o['runs'] for o in d['ops']))")
cell "/prompt?c=${SESSION}" -X POST -H 'content-type: application/json' -d '{"text":"again"}' >/dev/null
RUNS_AFTER=$(daemon /_ops | pyjson "print(sum(o['runs'] for o in d['ops']))")
REPLAYED=$(cell "/history?c=${SESSION}" | pyjson "print(sum(1 for m in d['messages'] if m['role']=='toolResult' and (m['message'].get('details') or {}).get('replayed')))")
[ "$RUNS_BEFORE" = "$RUNS_AFTER" ] && [ "$REPLAYED" -ge 1 ] \
  && pass "retry served from the ledger (runs stayed ${RUNS_AFTER}, replayed=${REPLAYED})" \
  || fail "the command re-ran: ${RUNS_BEFORE} -> ${RUNS_AFTER}, replayed=${REPLAYED}"

echo "== 5. the session survives SIGKILL of the node =="
BEFORE=$(cell "/history?c=${SESSION}" | pyjson "print(len(d['messages']))")
docker kill "$CONTAINER" >/dev/null
start_cell || fail "the replacement node never became healthy"
AFTER=""
for _ in $(seq 1 40); do
  AFTER=$(cell "/history?c=${SESSION}" | pyjson "print(len(d['messages']))" 2>/dev/null || echo "")
  [ -n "$AFTER" ] && break
  sleep 0.5
done
[ -n "$AFTER" ] && [ "$AFTER" = "$BEFORE" ] \
  && pass "a new process read all ${AFTER} messages back from the bucket" \
  || fail "transcript did not survive: ${BEFORE} before, '${AFTER}' after"

echo "== 6. every tool works, not just bash =="
# bash alone passing proves the transport, not the tool set. write creates a
# NESTED path, read takes a slice (offset 1, limit 1) so a whole-file read would
# fail it, and bash then observes what write actually wrote.
TOOLS_SESSION="${SESSION}-tools"
cell "/prompt?c=${TOOLS_SESSION}" -X POST -H 'content-type: application/json' -d '{
 "text":"exercise every tool",
 "script":[
  {"tool":"write","id":"w1","args":{"path":"notes/hello.txt","content":"line-one\nline-two\nline-three"}},
  {"tool":"read","id":"r1","args":{"path":"notes/hello.txt","offset":2,"limit":1}},
  {"tool":"bash","id":"b1","args":{"command":"wc -l < notes/hello.txt"}},
  {"text":"all three tools used"}
 ]}' >/dev/null
RESULTS=$(cell "/history?c=${TOOLS_SESSION}" | pyjson "
import json
out=[]
for m in d['messages']:
    if m['role']=='toolResult':
        c=m['message'].get('content') or [{}]
        # Newlines flattened before the fields are split with cut, which works
        # a line at a time: a multi-line result silently truncates every field
        # after it. pi read appends a more-lines hint on its own line, which is
        # exactly what made the bash claim read as empty.
        out.append((c[0].get('text') or '').strip().replace(chr(10),' '))
print('|'.join(out))")
# pi's read numbers lines from 1, so offset 2 is the second line. The
# hand-rolled tool this replaced was 0-based, and these claims kept its wording
# and its arithmetic until the exact-match below was split into three.
part() { echo "$RESULTS" | cut -d'|' -f"$1"; }
case "$(part 1)" in *"notes/hello.txt"*) pass "write created a nested path" ;;
  *) fail "write: $(part 1)" ;; esac
case "$(part 2)" in *"line-two"*) [ "${RESULTS#*line-one}" = "$RESULTS" ] \
      && pass "read returned the addressed line, not the whole file" \
      || fail "read returned the whole file: $(part 2)" ;;
  *) fail "read: $(part 2)" ;; esac
case "$(part 3)" in *"2"*) pass "bash observed what write wrote" ;;
  *) fail "bash: $(part 3)" ;; esac
KINDS=$(cell "/ops?c=${TOOLS_SESSION}" | pyjson "print(','.join(sorted(o['kind'] for o in d['ops'])))")
[ "$KINDS" = "bash,read,write" ] \
  && pass "all three are in the op ledger (${KINDS})" \
  || fail "op ledger holds: ${KINDS}"

echo "== 7. concurrent prompts to one cell do not interleave =="
# A session is sequential, but the Durable Object input gate does NOT make it so:
# it is released across an await on anything that is not storage, and a tool call
# is an await on HTTP. Before the queue in worker.js, six concurrent prompts
# produced every user message first and every turn afterwards — not a
# conversation, and each agent had already read a transcript missing the others.
CS="${SESSION}-conc"
# ASYNC, which is the shape a durable agent wants and the only shape celld
# 0.4.0 accepts: it closes concurrent in-flight requests to one Durable Object
# (measured: one 200, five "connection closed before message completed"), while
# 0.3.0 held them. Queued turns are rows plus an alarm, so ordering survives an
# eviction as well as a disconnect.
for i in 1 2 3 4 5 6; do
  cell "/prompt?c=${CS}&async=1" -X POST -H 'content-type: application/json' \
    -d "{\"text\":\"p${i}\",\"script\":[{\"tool\":\"bash\",\"id\":\"z${i}\",\"args\":{\"command\":\"sleep 0.15; echo done${i}\"}},{\"text\":\"ok${i}\"}]}" >/dev/null &
done
wait
# Drain the queue before judging the transcript.
for _ in $(seq 1 120); do
  LEFT=$(cell "/turns?c=${CS}" | pyjson "print(sum(1 for t in d['turns'] if t['status'] in ('pending','running')))")
  [ "$LEFT" = "0" ] && break
  sleep 0.5
done
PATTERN=$(cell "/history?c=${CS}" | pyjson "
import re
seq=[]
for m in d['messages']:
    c=m['message'].get('content') or []
    kind=m['role']
    for b in c:
        if b.get('type')=='toolCall': kind='call'
    seq.append(kind)
# Collapse to the repeating unit; six clean turns are user,assistant,toolResult,assistant x6
print(','.join(seq))")
EXPECTED="user,call,toolResult,assistant"
OK=1
IFS=',' read -ra P <<< "$PATTERN"
# ${P[i+1]-} with a default, because `set -u` makes indexing past the end a
# FATAL error, not an empty string. When the transcript was not a multiple of
# four this aborted the whole suite mid-claim — and the suite still exited 0, so
# claims 8 and 9 were silently skipped and the run looked clean. A test harness
# that can skip tests without saying so is worse than one that fails.
[ $(( ${#P[@]} % 4 )) -eq 0 ] || OK=0
for ((i=0; i<${#P[@]}; i+=4)); do
  GOT="${P[i]-},${P[i+1]-},${P[i+2]-},${P[i+3]-}"
  [ "$GOT" = "$EXPECTED" ] || OK=0
done
[ "${#P[@]}" = "24" ] && [ "$OK" = "1" ] \
  && pass "six concurrent prompts produced six clean turns, none interleaved" \
  || fail "interleaved transcript (${#P[@]} messages): ${PATTERN}"

echo "== 8. no secret reaches the bucket =="
# `celld deploy` uploads wrangler.json's vars into the deployment manifest. That
# is how a complete ChatGPT OAuth JWT ended up in three manifests under
# deploy/ptagent/ — in the org's S3 prefix on Platinum, versioned, readable by
# anything with bucket access, surviving every redeploy.
#
# Secrets now ride CELLD_VAR_* at the node instead. This asserts the outcome
# rather than the mechanism: scan every deployed object for anything that looks
# like a credential.
# ONE container, not one per object. This used to `docker run mc` for the find
# and then again for every object it found — 18 container starts in a suite run,
# on a 16 GB laptop already holding celld, MinIO and a node process. The Docker
# VM was SIGKILLed mid-suite twice before the cost of this loop was obvious.
#
# mc runs the whole walk itself and emits path\0body\0 pairs for the parser.
if SCAN=$(docker run --rm --network host --entrypoint sh quay.io/minio/mc -c \
  "mc alias set m http://127.0.0.1:${MINIO_PORT} celldev celldev123 >/dev/null 2>&1
   for f in \$(mc find m/${BUCKET}/${PREFIX}/deploy --name '*.json' 2>/dev/null); do
     printf '%s\\0' \"\$f\"
     mc cat \"\$f\" 2>/dev/null
     printf '\\0'
   done" 2>/dev/null | python3 test/scan-secrets.py); then
  pass "no credential value in any deployed object ($(echo "$SCAN" | grep -o 'scanned=[0-9]*'))"
else
  # 2 means the walk found nothing to look at, which is a broken check rather
  # than a clean bucket — a distinction the old form could not make, because it
  # exited 0 on an empty scan.
  case "$?" in
    2) fail "the secret scan examined NOTHING — $(echo "$SCAN" | grep -v '^scanned=' | tr '\n' ' ')" ;;
    *) fail "credential values in the bucket: $(echo "$SCAN" | grep -v '^scanned=' | tr '\n' ' ')" ;;
  esac
fi

echo "== 9. compaction bounds the transcript, which is the bill =="
# Every other cost here is orders of magnitude below a model turn. What costs
# money is re-sending the conversation EVERY turn, so a session's spend grows
# with the square of its length. Compaction is the one optimisation that pays
# for itself, and this asserts it actually fires and actually shrinks.
#
# CONTEXT_WINDOW makes it reachable without generating 200k tokens. The settings
# scale to the window (see settingsFor) because the defaults reserve 16384 and
# keep 20000 — numbers that are silently nonsense below ~40k.
# No restart: the window rides the request. Restarting a working celld node
# repeatedly is what kept killing the local Docker VM, so a claim that needs a
# restart to set one number is a claim that stops the suite finishing.
KS="${SESSION}-compact"
PAD=$(python3 -c 'print("padding "*120)')
PEAK=0
for i in $(seq 1 12); do
  cell "/prompt?c=${KS}" -X POST -H 'content-type: application/json' \
    -d "{\"contextWindow\":3000,\"text\":\"turn ${i} ${PAD}\",\"script\":[{\"tool\":\"bash\",\"id\":\"k${i}\",\"args\":{\"command\":\"echo ${i}\"}},{\"text\":\"reply ${i}\"}]}" >/dev/null
  T=$(cell "/context?c=${KS}&window=3000" | pyjson "print(d['tokens'])")
  [ "$T" -gt "$PEAK" ] && PEAK=$T
done
FINAL=$(cell "/context?c=${KS}&window=3000" | pyjson "print(d['tokens'])")
HEAD=$(cell "/history?c=${KS}" | pyjson "print(d['messages'][0]['role'] if d['messages'] else 'none')")
TAIL1=$(cell "/history?c=${KS}" | pyjson "print(d['messages'][1]['role'] if len(d['messages'])>1 else 'none')")
# Twelve turns of ~253 tokens each would be ~3000 unbounded; compaction must
# hold it below the peak it reached, and the transcript must begin with a
# summary whose tail starts at a turn boundary.
[ "$HEAD" = "compactionSummary" ] && [ "$TAIL1" = "user" ] && [ "$FINAL" -lt "$PEAK" ] \
  && pass "compacted: peak ${PEAK} -> ${FINAL} tokens, head is a summary, tail starts at a user turn" \
  || fail "head=${HEAD} tail1=${TAIL1} peak=${PEAK} final=${FINAL}"

# A count, not a closing sentence. The suite once aborted mid-claim and still
# printed a clean-looking tail; this makes a short run impossible to miss.
EXPECTED_PASSES=14
echo
if [ "$PASSED" -eq "$EXPECTED_PASSES" ]; then
  echo "all nine claims hold (${PASSED} assertions)."
else
  printf '  \033[31mINCOMPLETE\033[0m %s assertions ran, expected %s\n' "$PASSED" "$EXPECTED_PASSES"
  exit 1
fi
echo "(the Platinum tool backend is test/platinum.sh — run it separately)"

