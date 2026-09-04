#!/usr/bin/env bash
# STREAMING OVER A HIBERNATABLE SOCKET — and an honest boundary around it.
#
# With turns running in an alarm rather than on the request, the WebSocket is the
# only way a client sees progress. So this proves the stream carries what a
# watcher needs: which turn started, which tool ran, what it returned, when the
# turn finished.
#
# WHAT THIS DOES NOT PROVE, and an earlier version of it wrongly did:
#
#   That a socket survives the isolate being EVICTED. The worker uses
#   state.acceptWebSocket() and state.getWebSockets() — the hibernation API,
#   which celld implements and logs ("accepted hibernatable WebSocket") — so the
#   socket belongs to the runtime rather than the instance, and that is the whole
#   basis for "a parked session costs a file descriptor, not an isolate".
#
#   But I could not make celld evict a cell that holds an open socket. Not with
#   CELLD_IDLE_EVICT_S=3 and twenty seconds of silence (which evicted nothing at
#   all, even a cell with no socket), and not with CELLD_MAX_RESIDENT_CELLS=1
#   plus traffic to a second cell. An earlier run appeared to show survival, and
#   it did not: the eviction lines in the log belonged to a DIFFERENT cell, and
#   the socket whose isolate "was evicted" had never been evicted.
#
#   So the capacity claim rests on the API being the right one, not on a
#   measurement. That is worth saying out loud rather than dressing up.
set -euo pipefail
cd "$(dirname "$0")/.."
export PT_AGENT_SCRIPTED=1

CELL_PORT=${CELL_PORT:-18080}
C=pt-cell-$(python3 -c "import json;print(json.load(open('agent.config.json'))['name'])")
S=stream-$$

PASS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
cleanup() { node celldctl.mjs down >/dev/null 2>&1 || true; }
trap cleanup EXIT

node celldctl.mjs up >/dev/null 2>&1

echo "== the socket is accepted hibernatably =="
# SCOPED TO THIS RUN, AND POLLED — it used to be neither.
#
# The grep read the WHOLE container log for a constant string, and `up`
# deliberately keeps the node alive between suites, so one successful run left a
# line that satisfied this check forever after. Measured: with no socket opened
# at all this run, the old form still passed. That is the central claim of this
# file, and it could not fail.
#
# The fixed 2-second sleep was the other half. On a node that had just been
# restarted the line had not been written yet, and this failed twice in a row
# for no reason but timing. Polling at 2 Hz with a deadline fixes that without
# going back to the 20 Hz that used to get OrbStack killed.
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node test/wsstream-probe.mjs "$CELL_PORT" "$S" > /tmp/stream-out.txt 2>&1 &
PROBE=$!
SOCKETS=0
for _ in $(seq 1 30); do
  SOCKETS=$(curl -s "http://127.0.0.1:${CELL_PORT}/sockets?c=${S}" 2>/dev/null \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("sockets",0))' 2>/dev/null || echo 0)
  [ "$SOCKETS" = "1" ] && break
  sleep 0.5
done
[ "$SOCKETS" = "1" ] || fail "the cell does not hold the socket (${SOCKETS})"
HIB=""
for _ in $(seq 1 30); do
  if docker logs --since "$SINCE" "$C" 2>&1 | grep -q "accepted hibernatable WebSocket"; then HIB=yes; break; fi
  sleep 0.5
done
[ -n "$HIB" ] \
  && pass "celld accepted it through the hibernation API, not accept() — logged during THIS run" \
  || fail "celld did not log a hibernatable accept in this run — the socket is instance-bound"

echo "== a turn streams what a watcher needs =="
curl -s -o /dev/null -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${S}&async=1" \
  -H 'content-type: application/json' \
  -d '{"text":"stream","script":[
        {"tool":"bash","id":"st1","args":{"command":"echo STREAMED"}},
        {"tool":"write","id":"st2","args":{"path":"a.txt","content":"x"}},
        {"text":"done"}]}'
wait $PROBE || true
OUT=$(cat /tmp/stream-out.txt)

for want in turn_started tool_start tool_end turn_done; do
  case "$OUT" in *"$want"*) ;; *) fail "the stream never carried ${want}: ${OUT}" ;; esac
done
pass "turn_started -> tool_start -> tool_end -> turn_done all arrived"

case "$OUT" in
  *STREAMED*) pass "tool OUTPUT reached the watcher, not just an event name" ;;
  *) fail "tool output never streamed: ${OUT}" ;;
esac
case "$OUT" in
  *"tool=bash"*) pass "the event names which tool is running" ;;
  *) fail "no tool name in the stream" ;;
esac

echo "== the deeper questions: isolation, multiple watchers, reconnects =="
A="${S}-a"; B="${S}-b"
node test/wsdeep-probe.mjs "$CELL_PORT" "$A" "$B" 2 12000 > /tmp/deep.json 2>&1 &
DEEP=$!
sleep 2
# Drive a turn on A ONLY. Anything B sees is a cross-session leak.
curl -s -o /dev/null -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${A}&async=1" \
  -H 'content-type: application/json' \
  -d '{"text":"only A","script":[{"tool":"bash","id":"da1","args":{"command":"echo ONLY_A"}},{"text":"done"}]}'
sleep 3
# And one on B, so B is not silent merely because nothing happened anywhere.
curl -s -o /dev/null -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${B}&async=1" \
  -H 'content-type: application/json' \
  -d '{"text":"only B","script":[{"tool":"bash","id":"db1","args":{"command":"echo ONLY_B"}},{"text":"done"}]}'
wait $DEEP || true

python3 - /tmp/deep.json <<'PYEOF' > /tmp/deep-verdict.txt
import json, sys
d = json.load(open(sys.argv[1]))
w = {x["label"]: x for x in d["watchers"]}
out = []

def yes(name, cond, detail=""):
    out.append(("PASS" if cond else "FAIL", name, detail))

# A turn ran on each session, so every watcher should have seen ITS OWN.
a_turns = [l for l in w["A0"]["events"] if l == "turn_done"]
b_turns = [l for l in w["B0"]["events"] if l == "turn_done"]
yes("each session's watcher saw its own turn complete",
    len(a_turns) >= 1 and len(b_turns) >= 1, f"A={len(a_turns)} B={len(b_turns)}")

# ISOLATION: exactly one turn each. A watcher seeing two turn_done saw the other
# session's traffic, which is a tenant leak, not a cosmetic bug.
yes("no cross-session leakage",
    len(a_turns) == 1 and len(b_turns) == 1,
    f"A saw {len(a_turns)} turn_done, B saw {len(b_turns)} (1 each is correct)")

# Every watcher on a session must get the same stream, not just the first.
yes("both watchers on one session received the turn",
    w["A0"]["events"].count("turn_done") == w["A1"]["events"].count("turn_done") == 1,
    f'A0={w["A0"]["events"].count("turn_done")} A1={w["A1"]["events"].count("turn_done")}')

# hello on connect, always, including for a late joiner.
yes("every watcher got hello on connect",
    all(x["events"] and x["events"][0] == "hello" for x in d["watchers"] if x["opened"]),
    str({x["label"]: (x["events"][:1] or ["<none>"]) for x in d["watchers"]}))

# A reconnecting client is served like any other.
yes("a reconnecting watcher is served",
    "A-reconnect" in w and w["A-reconnect"]["events"] and w["A-reconnect"]["events"][0] == "hello",
    str(w.get("A-reconnect", {}).get("events", [])[:3]))

# A client that drops mid-stream must not take the turn with it.
yes("a dropped watcher did not break the turn",
    w["A0"]["events"].count("turn_done") == 1,
    "A-flap closed early; A0 still completed")

# The socket protocol answers status.
yes("the socket answers a status request",
    any("status" in x["events"] for x in d["watchers"]),
    str([x["events"] for x in d["watchers"] if "status" in x["events"]][:1]))

# Ordering within a session: started before done.
order = [o for o in d["order"] if o.startswith("A0:")]
yes("events arrive in order (turn_started before turn_done)",
    "A0:turn_started" in order and "A0:turn_done" in order
    and order.index("A0:turn_started") < order.index("A0:turn_done"),
    ",".join(order[:6]))

for status, name, detail in out:
    print(f"{status}|{name}|{detail}")
PYEOF

while IFS='|' read -r status name detail; do
  [ "$status" = "PASS" ] && pass "$name" || fail "$name — $detail"
done < /tmp/deep-verdict.txt

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
EXPECTED_PASSES=12
if [ "$PASS" -ne "$EXPECTED_PASSES" ]; then
  printf '  \033[31mINCOMPLETE\033[0m %s claims ran, expected %s\n' "$PASS" "$EXPECTED_PASSES"; exit 1
fi
echo "streaming holds (${PASS} claims). Socket survival across an eviction is NOT tested here — see the header."
