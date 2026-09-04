#!/usr/bin/env bash
# A CRASH IN THE MIDDLE OF A TOOL CALL — what the op ledger is for.
#
# Claim 4 in e2e.sh proves a RETRY is not re-executed. That is the easy half: the
# turn completed, the transcript is consistent, and the daemon's cache answers.
# The hard half is a cell that dies WHILE a command is running:
#
#   • the command may have completed on the daemon, or may not have
#   • the cell has no assistant message and no tool result for it
#   • on resume, nothing in the TRANSCRIPT says the call ever happened
#
# The ops table is the answer, and the reason it is written BEFORE the fetch with
# INSERT OR IGNORE rather than after: a row left at status='running' is the cell
# telling its successor "this may have run". Losing that distinction is how a
# resumed agent runs `rm -rf build && ...` a second time.
#
# Its own script, not another claim in e2e.sh, because it needs a kill and a
# restart of a working celld node — and doing that one more time per suite run is
# what kept killing the local Docker VM.
set -euo pipefail
cd "$(dirname "$0")/.."
export PT_AGENT_SCRIPTED=1

CELL_PORT=${CELL_PORT:-18080}
DAEMON_PORT=${DAEMON_PORT:-7070}
TOKEN=${TOKEN:-dev-token}
C=pt-cell-$(python3 -c "import json;print(json.load(open('agent.config.json'))['name'])")
S=crash-$$
OPID="crashop-$$"

PASS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
cell()   { curl -s -m 90 "http://127.0.0.1:${CELL_PORT}$1" "${@:2}"; }
daemon() { curl -s -m 20 "http://127.0.0.1:${DAEMON_PORT}$1" -H "authorization: Bearer ${TOKEN}" "${@:2}"; }
pyjson() { python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False);$1"; }

node celldctl.mjs up >/dev/null 2>&1

echo "== a cell that dies mid-command =="
# A command long enough to still be running when the node is killed, and one
# whose completion is OBSERVABLE from outside the cell: it writes a file on the
# daemon's filesystem after the sleep.
MARK="/tmp/agent-cell-work/${S}/finished.txt"
# A DURABLE COUNT OF EXECUTIONS, appended BEFORE the sleep.
#
# The re-execution claim below used to compare the daemon's own /_ops counter
# either side of the retry — and that counter lives in memory, in the daemon
# this test SIGKILLs. Both readings were 0 every run, so `0 = 0` passed whatever
# the code did. Verified by removing the daemon's ledger replay: THIS suite
# stayed green.
#
# The branch itself is covered — daemon-persist, daemon-safety and
# ledger-parity all fail without it. What was missing was this suite testing
# what its own line says, in the one file whose entire subject is crash
# recovery.
#
# This file is on the daemon's filesystem, so it survives the kill, and it is
# written before the sleep — one line per EXECUTION, whether or not that
# execution ever finished. That is the distinction the claim needs: the race
# decides whether the command COMPLETED, and a retry must not start it again
# either way.
RAN="/tmp/agent-cell-work/${S}/ran.txt"
cell "/prompt?c=${S}" -X POST -H 'content-type: application/json' -d "{
  \"text\":\"long\",
  \"script\":[{\"tool\":\"bash\",\"id\":\"${OPID}\",\"args\":{\"command\":\"echo RAN >> ran.txt; sleep 6; echo COMPLETED > finished.txt\"}},{\"text\":\"done\"}]
}" >/dev/null 2>&1 &
PROMPT_PID=$!

# Wait until the op is actually in flight — recorded, not yet finished. Polling
# the ledger rather than sleeping a guessed interval: the point of the claim is
# the state DURING the call, so the test must observe it rather than assume it.
INFLIGHT=""
for _ in $(seq 1 60); do
  INFLIGHT=$(cell "/ops?c=${S}" | pyjson "print(','.join(f\"{o['id']}:{o['status']}\" for o in d['ops']))" 2>/dev/null || echo "")
  case "$INFLIGHT" in *"${OPID}:running"*) break ;; esac
  sleep 0.25
done
case "$INFLIGHT" in
  *"${OPID}:running"*) pass "intent is recorded BEFORE the call (op is 'running' mid-flight)" ;;
  *) fail "never saw the op in flight; ledger was: '${INFLIGHT}'" ;;
esac

# Kill the node while the command is still on the daemon.
docker kill "$C" >/dev/null
kill $PROMPT_PID 2>/dev/null || true
pass "node SIGKILLed while the command was still running"

# Bring the SAME node identity back (celld routes a cell to its owner by node id).
docker start "$C" >/dev/null
for _ in $(seq 1 400); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CELL_PORT}/health" 2>/dev/null)" = "200" ] && break
  sleep 0.25
done

echo "== what the resumed cell knows =="
AFTER=$(cell "/ops?c=${S}" | pyjson "print(','.join(f\"{o['id']}:{o['status']}\" for o in d['ops']))")
case "$AFTER" in
  *"${OPID}:running"*)
    pass "the op survived the crash still marked 'running' — 'may have run', not 'never started'" ;;
  *"${OPID}:done"*)
    fail "the op reads 'done', but nothing wrote a result — the ledger is lying: ${AFTER}" ;;
  *) fail "the op did not survive the crash: '${AFTER}'" ;;
esac

# The transcript, by contrast, has nothing to say about it: the assistant message
# and tool result are written together at turn_end, which never came.
TRANSCRIPT=$(cell "/history?c=${S}" | pyjson "print(','.join(m['role'] for m in d['messages']))")
[ "$TRANSCRIPT" = "user" ] \
  && pass "the transcript holds only the user message — the ledger is the ONLY record of the call" \
  || fail "expected just the user message, got: ${TRANSCRIPT}"

echo "== and the command is not run twice =="
# Whether the sleep finished before the kill or not, a retry carrying the SAME
# toolCallId must not execute it again.
EXECS_BEFORE=$(wc -l < "$RAN" 2>/dev/null | tr -d ' '); EXECS_BEFORE=${EXECS_BEFORE:-0}
[ "$EXECS_BEFORE" = "1" ] \
  && pass "the command executed exactly once before the retry (ran.txt has 1 line)" \
  || fail "expected exactly one execution before the retry, ran.txt has ${EXECS_BEFORE}"
cell "/prompt?c=${S}" -X POST -H 'content-type: application/json' -d "{
  \"text\":\"retry\",
  \"script\":[{\"tool\":\"bash\",\"id\":\"${OPID}\",\"args\":{\"command\":\"echo RAN >> ran.txt; sleep 6; echo COMPLETED > finished.txt\"}},{\"text\":\"done\"}]
}" >/dev/null
EXECS_AFTER=$(wc -l < "$RAN" 2>/dev/null | tr -d ' '); EXECS_AFTER=${EXECS_AFTER:-0}
[ "$EXECS_AFTER" = "1" ] \
  && pass "AND THE RETRY DID NOT EXECUTE IT AGAIN — still 1 execution, proved by a file the kill could not reset" \
  || fail "the command ran again: ${EXECS_BEFORE} -> ${EXECS_AFTER} executions"

FINAL=$(cell "/ops?c=${S}" | pyjson "print(','.join(f\"{o['id']}:{o['status']}\" for o in d['ops']))")
# RESOLVED, not necessarily 'done'. Which of the two legitimate outcomes this
# lands on depends on WHERE the SIGKILL fell, and both are correct:
#
#   the command reached the daemon and completed -> the daemon replays it and
#                                                   the op ends 'done'
#   the kill landed first (runs stayed 0)        -> the daemon knows the op was
#                                                   in flight when IT died,
#                                                   reports an unknown outcome,
#                                                   and the op ends 'error'
#
# Demanding 'done' made this suite fail about one run in five, always with
# "op never resolved: ...:error" — which reads like a bug and is the system
# being careful. Caught by a preserved log after three clean reruns could not
# reproduce it.
#
# What must hold either way is that the op is NO LONGER 'running': that state
# means "may have run", and it would make every later retry of this id
# permanently unanswerable.
case "$FINAL" in
  *"${OPID}:running"*) fail "the op is STILL 'running' — every later retry of it is unanswerable: ${FINAL}" ;;
  *"${OPID}:done"*)    pass "the op resolved as done — the command completed before the kill: ${FINAL}" ;;
  *"${OPID}:error"*)   pass "the op resolved as error — the kill landed first, so the outcome is unknown: ${FINAL}" ;;
  *) fail "op never resolved: ${FINAL}" ;;
esac

echo

# A COUNT, NOT A CLOSING SENTENCE.
#
# Every one of these suites ends by announcing that it holds. e2e alone checked
# that it had actually RUN — its comment says why: "the suite once aborted
# mid-claim and still printed a clean-looking tail". The other six printed the
# same confident line whatever they had got through, and the only signal was a
# number in all.sh's summary that nobody compares to anything.
#
# It is not hypothetical. Eviction reported 12 claims one sweep and 13 the next,
# and that was caught by reading, not by the suite.
EXPECTED_PASSES=7
if [ "$PASS" -ne "$EXPECTED_PASSES" ]; then
  printf '  \033[31mINCOMPLETE\033[0m %s claims ran, expected %s\n' "$PASS" "$EXPECTED_PASSES"; exit 1
fi
echo "crash recovery holds (${PASS} claims)."
