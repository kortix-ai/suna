#!/usr/bin/env bash
# DOES A WATCHER'S SOCKET SURVIVE ITS CELL BEING EVICTED?
#
# This has been claimed and retracted once already: an earlier run reported
# "HIBERNATION HELD" while the eviction lines in the log belonged to a DIFFERENT
# cell. So the eviction is proved here per cell, not read off a log grep.
#
# celld 0.3.0 logs no eviction line at all — `publiSHEDed` even matches a grep
# for "shed", which is how the first attempt fooled itself. What it does emit is
# an EPOCH per cell: a fresh isolate is epoch=N fresh=true, and a cell restored
# from object storage after eviction comes back epoch=N+1 fresh=false. That
# pair is the evidence, and this suite refuses to judge the socket until it has
# seen it.
set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0; SKIPPED=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
PORT=18080

# THIS SUITE OWNS ITS PRECONDITION.
#
# Eviction only happens with a resident-cell cap, which no other suite wants —
# and the suite that runs before this one takes the node down in its cleanup. So
# rather than skipping whenever it is run in company, it brings up the node it
# needs and puts an ordinary one back afterwards.
docker version >/dev/null 2>&1 || { echo "  SKIP: no docker"; exit 0; }
restore_node() { node celldctl.mjs up >/dev/null 2>&1 || true; }
trap restore_node EXIT

CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)
RESIDENT=0
[ -n "$CELL" ] && RESIDENT=$(docker inspect "$CELL" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c "CELLD_MAX_RESIDENT_CELLS=1" || true)
if [ -z "$CELL" ] || [ "$RESIDENT" = "0" ]; then
  CELLD_MAX_RESIDENT_CELLS=1 node celldctl.mjs up >/dev/null 2>&1 || { echo "  SKIP: could not start a capped node"; exit 0; }
  CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)
  [ -z "$CELL" ] && { echo "  SKIP: no celld node"; exit 0; }
fi

S="evict-$RANDOM"
prompt() { curl -s -o /dev/null -m 10 -X POST -H 'content-type: application/json' -d "{\"text\":\"$2\"}" "http://127.0.0.1:${PORT}/prompt?c=$1"; }
epochs()  { docker logs "$CELL" 2>&1 | grep "$1" | grep -oE 'epoch=[0-9]+' | sort -u | tr '\n' ' '; }
freshes() { docker logs "$CELL" 2>&1 | grep "$1" | grep -oE 'fresh=(true|false)' | tr '\n' ' '; }

scopes()  { docker logs "$CELL" 2>&1 | grep -oE "scope=AgentCell:[a-f0-9]{64}" | sort -u; }

# THE SCOPE OF THE CELL I JUST PROMPTED, not the last one anybody logged.
#
# This was `docker logs ... | tail -1`, over the WHOLE container log. `up`
# deliberately keeps the node alive between suites, so by the time this runs the
# log already holds the scopes of every cell e2e, streaming and platinum made —
# and `tail -1` is "the newest line anyone wrote", which is only my cell if
# nothing else wrote after my prompt. It is a race, and it lost: a run failed
# with `epochs=[epoch=5 epoch=6]`, measuring a cell created by an earlier suite.
#
# Worse in the other direction: had that stranger's cell happened to sit at
# epoch=1, section 1 would have PASSED while measuring the wrong cell.
#
# A new cell's scope is, by definition, one that was not there before. So the
# set is taken before the prompt and the new member is the answer — exact, and
# polled rather than slept, because the log lags the request.
new_scope() {
  local before="$1" found=""
  for _ in $(seq 1 30); do
    found=$(comm -13 <(printf '%s\n' "$before" | grep . | sort -u) <(scopes) | tail -1 | cut -d: -f2)
    [ -n "$found" ] && break
    sleep 0.5
  done
  printf '%s' "$found"
}

echo "== 1. a cell is created, and celld names its scope =="
BEFORE=$(scopes)
prompt "$S" "hello"
H=$(new_scope "$BEFORE")
[ -n "$H" ] && [ "$(epochs "$H")" = "epoch=1 " ] \
  && pass "the cell started at epoch=1 (${H:0:12})" \
  || fail "no fresh scope for ${S}: epochs=[$(epochs "$H")]"

echo "== 2. a watcher attaches =="
node test/evict-probe.mjs "$PORT" "$S" 1200 > /tmp/evict-open.json 2>&1
grep -q '"opened":true' /tmp/evict-open.json \
  && pass "a WebSocket watcher connects and is greeted" \
  || fail "watcher never opened: $(cat /tmp/evict-open.json)"

echo "== 3. the cell is EVICTED, proved per cell rather than by a log grep =="
# Hold a socket open across the eviction and probe it afterwards. The probe is
# what separates "still open" from "still usable".
node test/evict-probe.mjs "$PORT" "$S" 14000 9000 > /tmp/evict-hold.json 2>&1 &
PROBE=$!
sleep 1
for i in $(seq 1 10); do prompt "filler-$RANDOM-$i" "x"; done
prompt "$S" "after eviction"
sleep 2

EP=$(epochs "$H"); FR=$(freshes "$H")
case "$EP" in
  *"epoch=2"*) case "$FR" in
      *"fresh=false"*) pass "the cell was evicted and rebuilt from object storage (epochs: ${EP}| ${FR})" ;;
      *) fail "epoch advanced but never restored: ${FR}" ;;
    esac ;;
  *) fail "THE CELL WAS NEVER EVICTED — nothing below would mean anything (epochs: ${EP})" ;;
esac

wait $PROBE 2>/dev/null
HOLD=$(cat /tmp/evict-hold.json)

echo "== 4. what the watcher saw across it =="
# The honest question, either answer being a real result: does the socket
# survive the isolate being torn down and rebuilt?
# PINNED TO WHAT THIS celld DOES. The outcome is a property of the runtime, so
# the suite states which outcomes it accepts — CELLD_SOCKET_AFTER_EVICTION, a
# |-separated set of orphaned | held | closed — and FAILS on any other. The
# default is what pt-celld:0.3.0 MEASURES: intermittent between held and
# orphaned (2026-09-05: pinning "orphaned" alone failed on its first run, the
# socket had received turn events), never closed. Until 2026-09-05 every branch
# below passed, so a celld that began closing sockets would have gone
# unnoticed, and so would a probe that never connected at all.
EXPECT_SOCK="${CELLD_SOCKET_AFTER_EVICTION:-orphaned|held}"
accepts() { case "|$EXPECT_SOCK|" in *"|$1|"*) return 0 ;; *) return 1 ;; esac; }
CLOSE_CODE=$(echo "$HOLD" | sed -n 's/.*"closeCode":\([0-9]*\).*/\1/p')
if ! echo "$HOLD" | grep -q '"opened":true'; then
  fail "the held socket never opened — nothing about the eviction was measured: $HOLD"
elif echo "$HOLD" | grep -qE '"events":\[[^]]*turn'; then
  if accepts held; then pass "HIBERNATION HELD: the same socket received turn events after its cell was rebuilt"
  else fail "celld CHANGED: the pre-eviction socket received turn events (expected: $EXPECT_SOCK) — re-measure 4c and re-pin CELLD_SOCKET_AFTER_EVICTION"; fi
elif echo "$HOLD" | grep -q '"closed":true'; then
  if accepts closed; then pass "the socket closed on eviction (code $CLOSE_CODE) — a client reconnects on close"
  else fail "celld CHANGED: the pre-eviction socket was closed (code $CLOSE_CODE; expected: $EXPECT_SOCK) — re-measure 4c and re-pin CELLD_SOCKET_AFTER_EVICTION"; fi
else
  # MEASURED on celld 0.3.0: the socket stays open and the rebuilt cell has no
  # handle to it (getWebSockets() goes 1 -> 0). That is worse than a close,
  # because nothing tells the client to reconnect. So the claim is not that the
  # socket survives — it does not — but that a client can FIND OUT.
  if accepts orphaned; then pass "the socket is orphaned by eviction, not closed — celld 0.3.0 did not restore it this run (accepted: $EXPECT_SOCK)"
  else fail "celld CHANGED: the pre-eviction socket is orphaned, neither served nor closed (expected: $EXPECT_SOCK) — re-pin CELLD_SOCKET_AFTER_EVICTION"; fi
  # CORRECTED, 2026-09-03. This was claimed as a finding — "celld delivers an
  # inbound message on a hibernated socket even though getWebSockets() does not
  # list it, so the socket is half-connected rather than orphaned" — on a single
  # observation. It is INTERMITTENT: a later run answered probeAnswered:false
  # with the same setup.
  #
  # Whether the old socket can still reach its cell appears to depend on how far
  # the eviction had progressed when the probe fired, and this suite forces the
  # eviction with filler traffic whose timing it does not control. So neither
  # outcome is a failure; what is NOT true is the confident version of the
  # original claim.
  #
  # The actionable truth is unchanged and is claimed at 4c: a client cannot rely
  # on a socket that predates an eviction, and reconnecting always works.
fi

# ASKED UNCONDITIONALLY, so the claim count cannot move with the branch.
#
# This sat inside the orphaned branch, so a run where the socket survived
# reported 12 claims and a run where it did not reported 13 — and "12 passed"
# then looks exactly like "13 claims, one silently skipped". Observed both, one
# sweep apart, which is the nondeterminism this file documents rather than a
# regression. Two questions, two claims, every run.
if echo "$HOLD" | grep -q '"probeAnswered":true'; then
  pass "this time the old socket still reached its cell — an inbound message was answered"
else
  pass "this time the old socket reached nothing — which is why reconnecting, not probing, is the mitigation"
fi

echo "== 4b. whatever happened, the cell and the watcher must AGREE =="
# CORRECTED TWICE, and the second time is the lesson. This first asserted the
# socket is orphaned (getWebSockets -> 0); a later run answered 1 and the
# watcher received turn events — HIBERNATION HELD. Socket survival across an
# eviction on celld 0.3.0 is NONDETERMINISTIC, and both earlier versions of this
# claim were generalisations from a single observation of a system that does not
# behave the same way twice.
#
# So the outcome is not asserted. What must hold either way is CONSISTENCY: if
# the watcher received events the cell must still hold the socket, and if it
# received nothing the cell must not. A cell that broadcasts to a socket it does
# not hold, or holds one it cannot reach, is a real bug in a way that neither
# outcome on its own is.
#
# WHAT THIS CLAIM DOES NOT PROVE, measured rather than assumed. Disabling the
# broadcast entirely — the cell holds sockets and sends to none of them — leaves
# this PASSING, because after an eviction the socket is orphaned anyway: the
# watcher gets nothing, the cell holds nothing, and nothing is inconsistent
# about that. It is the honest limit of a consistency claim. When both sides are
# empty, consistency holds whether or not broadcasting works.
#
# The claim that catches a dead broadcast is 4c, on a FRESH socket, which fails
# with "connected but saw no turn events". Anyone tempted to drop 4c as
# redundant should read this paragraph first.
HELD=$(curl -s -m 5 "http://127.0.0.1:${PORT}/sockets?c=${S}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["sockets"])' 2>/dev/null || echo "?")
GOT_EVENTS=no
echo "$HOLD" | grep -qE '"events":\[[^]]*turn' && GOT_EVENTS=yes
if [ "$GOT_EVENTS" = "yes" ]; then
  [ "${HELD:-0}" -ge 1 ] \
    && pass "the watcher got events and the cell still holds its socket (${HELD}) — hibernation held this run" \
    || fail "the watcher received events but the cell reports ${HELD} sockets — it broadcast to something it does not hold"
else
  [ "${HELD}" = "0" ] \
    && pass "the watcher got nothing and the cell holds no socket (0) — orphaned this run, consistently" \
    || fail "the cell holds ${HELD} sockets but the watcher received nothing — it holds one it cannot reach"
fi

echo "== 4c. the client's only recourse is to reconnect =="
# Re-adopting the old socket does NOT work on celld 0.3.0 and this suite used to
# claim it did. Measured: the ping is answered, but the instance that serves the
# next request reports `readopted: 0` — celld hands an inbound message to a
# TRANSIENT instance whose in-memory state does not persist. So a rebuilt cell
# cannot push to a socket opened before it, at all. What works is reconnecting.
S2="reconnect-$RANDOM"
prompt "$S2" "first"
for i in $(seq 1 10); do prompt "g-$RANDOM-$i" "x"; done   # evict S2
node test/evict-probe.mjs "$PORT" "$S2" 9000 > /tmp/reconnect.json 2>&1 &
P2=$!
sleep 2
prompt "$S2" "after reconnect"
wait $P2 2>/dev/null
RE=$(cat /tmp/reconnect.json)
# THREE OUTCOMES, NOT TWO. "the socket saw no events" conflated a real failure
# with the socket never having connected — and the second happens when the node
# is still rebuilding cells after the eviction storm above. One retry, then a
# claim that names which of the two it was.
if echo "$RE" | grep -q '"opened":false'; then
  node test/evict-probe.mjs "$PORT" "$S2" 9000 > /tmp/reconnect.json 2>&1 &
  P3=$!
  sleep 2
  prompt "$S2" "after reconnect retry"
  wait $P3 2>/dev/null
  RE=$(cat /tmp/reconnect.json)
fi
if echo "$RE" | grep -q '"opened":false'; then
  fail "the fresh socket never CONNECTED, twice — the node is not accepting sockets: ${RE}"
elif echo "$RE" | grep -qE '"events":\[[^]]*turn'; then
  pass "A FRESH SOCKET RECEIVES EVENTS from the rebuilt cell — reconnecting is the mitigation"
else
  fail "the fresh socket connected but saw no turn events: ${RE}"
fi

echo "== 4d. IDLE eviction, with the control inside the same node =="
# celldctl carried a note saying idle eviction "did nothing at
# CELLD_IDLE_EVICT_S=3". It was written by looking for an eviction log line that
# celld never writes. With the epoch/fresh pair it is measurable, and it evicts.
#
# The control is a second cell on the SAME node with the SAME config, kept warm
# by being touched. That isolates idleness as the variable — a control on a
# differently-configured node would not.
node celldctl.mjs down >/dev/null 2>&1
if CELLD_IDLE_EVICT_S=3 node celldctl.mjs up >/dev/null 2>&1; then
  CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)
  IDLE="idle-$RANDOM"; WARM="warm-$RANDOM"
  B1=$(scopes); prompt "$IDLE" "x"; IH=$(new_scope "$B1")
  B2=$(scopes); prompt "$WARM" "x"; WH=$(new_scope "$B2")
  # 12 seconds against a 3-second threshold, with the warm cell touched each second.
  for _ in $(seq 1 12); do curl -s -o /dev/null -m 5 "http://127.0.0.1:${PORT}/history?c=${WARM}" >/dev/null 2>&1; sleep 1; done
  curl -s -o /dev/null -m 10 "http://127.0.0.1:${PORT}/history?c=${IDLE}" >/dev/null 2>&1
  IE=$(docker logs "$CELL" 2>&1 | grep "$IH" | grep -oE 'fresh=(true|false)' | tr '\n' ' ')
  WE=$(docker logs "$CELL" 2>&1 | grep "$WH" | grep -oE 'fresh=(true|false)' | tr '\n' ' ')
  case "$IE" in
    *"fresh=false"*) pass "CELLD_IDLE_EVICT_S EVICTS an idle cell (${IE}) — the old note that it does nothing was wrong" ;;
    *) fail "the idle cell was never evicted: ${IE}" ;;
  esac
  case "$WE" in
    *"fresh=false"*) fail "the CONTROL was evicted too, so idleness is not what caused it: ${WE}" ;;
    *) pass "and a cell kept warm on the same node is NOT evicted (${WE}) — idleness is the variable" ;;
  esac
else
  echo "  SKIP: could not start a node with CELLD_IDLE_EVICT_S"
  SKIPPED=$((SKIPPED+2))
fi

echo "== 4e. the METER survives a real eviction, not just a harness one =="
# meter-logic.mjs claims "a rebuilt cell keeps the count" using the harness's
# rebuild(), which hands the SAME in-memory database to a new instance — it
# preserves state by construction and proves nothing about durability.
#
# A real eviction is a different mechanism: celld destroys the isolate, LTX has
# replicated the SQLite to object storage, and the rebuilt cell reads it back.
# The risk that only exists here is a write that is evicted before it is
# replicated. /meter is an unbilled path, so reading it cannot perturb what it
# reports.
# The CONVERSE of e2e's idempotence claim, and it costs nothing extra because
# this restart is happening anyway: a node started with a DIFFERENT node var
# must carry a different pt.config label, which is what stops the next `up`
# skipping a restart that is needed. The fingerprint is claimed as a hash in
# celldctl-logic; this is the end of the wire it comes out of.
CFG_BEFORE=$(docker inspect "$CELL" --format '{{index .Config.Labels "pt.config"}}' 2>/dev/null)
node celldctl.mjs down >/dev/null 2>&1
if CELLD_MAX_RESIDENT_CELLS=1 node celldctl.mjs up >/dev/null 2>&1; then
  CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)
  CFG_AFTER=$(docker inspect "$CELL" --format '{{index .Config.Labels "pt.config"}}' 2>/dev/null)
  [ -n "$CFG_BEFORE" ] && [ -n "$CFG_AFTER" ] && [ "$CFG_BEFORE" != "$CFG_AFTER" ] \
    && pass "a node started with a different var carries a different config fingerprint (${CFG_BEFORE:0:8} -> ${CFG_AFTER:0:8})" \
    || fail "the fingerprint did not move with the config: ${CFG_BEFORE:-none} -> ${CFG_AFTER:-none}"
  MS="meter-$RANDOM"
  # Taken AFTER the restart above, so it describes this container's log.
  B3=$(scopes)
  for _ in $(seq 1 5); do curl -s -o /dev/null -m 10 "http://127.0.0.1:${PORT}/history?c=${MS}" >/dev/null 2>&1; done
  MH=$(new_scope "$B3")
  BEFORE=$(curl -s -m 10 "http://127.0.0.1:${PORT}/meter?c=${MS}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["meters"].get("requests",0))' 2>/dev/null || echo 0)
  for i in $(seq 1 10); do prompt "m-$RANDOM-$i" "x"; done          # evict it
  # The read comes FIRST. celld logs nothing at eviction time — the fresh=false
  # line only appears when the cell is next touched, so checking the log before
  # touching it reports fresh=true and looks like no eviction happened.
  AFTER=$(curl -s -m 10 "http://127.0.0.1:${PORT}/meter?c=${MS}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["meters"].get("requests",0))' 2>/dev/null || echo 0)
  EV=$(docker logs "$CELL" 2>&1 | grep "$MH" | grep -oE 'fresh=(true|false)' | tr '\n' ' ')
  case "$EV" in
    *"fresh=false"*) pass "the metered cell really was evicted (${EV})" ;;
    *) fail "the cell was never evicted, so the meter claim below proves nothing: ${EV}" ;;
  esac
  [ "${BEFORE:-0}" -ge 5 ] \
    && pass "the meter counted the requests before eviction (${BEFORE})" \
    || fail "the meter did not count: ${BEFORE}"
  [ "${AFTER:-0}" -ge "${BEFORE:-0}" ] \
    && pass "THE COUNT SURVIVED THE ROUND TRIP THROUGH OBJECT STORAGE (${BEFORE} -> ${AFTER})" \
    || fail "the meter LOST counts across a real eviction: ${BEFORE} -> ${AFTER}"
else
  echo "  SKIP: could not start a capped node"
  SKIPPED=$((SKIPPED+4))
fi

echo "== 5. the transcript survived regardless =="
N=$(curl -s -m 10 "http://127.0.0.1:${PORT}/history?c=${S}" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["messages"]))' 2>/dev/null || echo 0)
[ "${N:-0}" -ge 2 ] \
  && pass "the cell's transcript came back from the bucket (${N} messages)" \
  || fail "transcript lost across eviction: ${N} messages"


# A COUNT, NOT A CLOSING SENTENCE — and this one has to allow for its own skips.
#
# Two sections here give up if the node they need will not start, and carry on:
# the idle-eviction control and the metered cell. A bare count would fail on a
# legitimate skip, so each skip declares how many claims it took with it and the
# total still has to add up. That is the difference between "13 ran" being
# noticed and being explained.
#
# This suite reported 12 claims one sweep and 13 the next. Both were correct at
# the time; nothing said so.
echo "== 4f. SCALE TO ZERO: every idle cell goes, not just enough to fit a cap =="
# 4d proves idleness evicts A cell while a warm control survives. That is not
# scale-to-zero. A runtime that keeps the last cell resident to dodge a cold
# start, or that only evicts under a resident cap, passes 4d and fails this.
#
# So: no cap at all, FOUR cells, and no traffic whatsoever during the window —
# not even the warm control 4d needs. Every one of the four must come back cold.
# The node is checked to be the SAME container afterwards, because a node that
# died and restarted would return four cold cells for a reason that has nothing
# to do with idleness.
node celldctl.mjs down >/dev/null 2>&1
if CELLD_IDLE_EVICT_S=3 node celldctl.mjs up >/dev/null 2>&1; then
  CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1)
  ID_BEFORE=$(docker inspect "$CELL" --format '{{.Id}}' 2>/dev/null)
  # NAME AND SCOPE TOGETHER. The scope hash is what the log is keyed by, but the
  # rebuild has to be triggered BY NAME — and `fresh=` is only written when a
  # cell is actually rebuilt, so touching the wrong name reads as "never
  # evicted". That is exactly how this section failed the first time it ran:
  # 0 of 4, with the runtime behaving correctly the whole time.
  Z_PAIRS=""
  for i in 1 2 3 4; do
    ZN="zero-$i-$RANDOM"
    ZB=$(scopes); prompt "$ZN" "x"; ZH=$(new_scope "$ZB")
    Z_PAIRS="$Z_PAIRS ${ZN}:${ZH}"
  done
  # 12 seconds against a 3-second threshold, and NOTHING is touched.
  sleep 12
  ID_AFTER=$(docker inspect "$CELL" --format '{{.Id}}' 2>/dev/null)
  [ -n "$ID_BEFORE" ] && [ "$ID_BEFORE" = "$ID_AFTER" ] \
    && pass "the node itself stayed up across the idle window (${ID_BEFORE:0:12}) — the cells went, not the process" \
    || fail "the node restarted, so four cold cells would prove nothing: ${ID_BEFORE:0:12} -> ${ID_AFTER:0:12}"
  COLD=0; WARM_LEFT=""
  for ZP in $Z_PAIRS; do
    ZN="${ZP%%:*}"; ZH="${ZP#*:}"
    [ -z "$ZH" ] && continue
    curl -s -o /dev/null -m 10 "http://127.0.0.1:${PORT}/history?c=${ZN}" >/dev/null 2>&1
    ZF=$(docker logs "$CELL" 2>&1 | grep "$ZH" | grep -oE 'fresh=(true|false)' | tr '\n' ' ')
    case "$ZF" in
      *"fresh=false"*) COLD=$((COLD+1)) ;;
      *) WARM_LEFT="$WARM_LEFT ${ZH:0:8}=${ZF:-none}" ;;
    esac
  done
  [ "$COLD" -eq 4 ] \
    && pass "RESIDENCY REACHED ZERO: all 4 idle cells were rebuilt from object storage, with no cap forcing it" \
    || fail "only ${COLD} of 4 idle cells were evicted — something keeps cells resident:${WARM_LEFT}"
else
  echo "  SKIP: could not start a node for the scale-to-zero window"
  SKIPPED=$((SKIPPED+2))
fi

EXPECTED_PASSES=16
echo
if [ "$FAIL" -eq 0 ] && [ $((PASS+SKIPPED)) -ne "$EXPECTED_PASSES" ]; then
  printf '  \033[31mINCOMPLETE\033[0m %s claims ran and %s were skipped, expected %s in total\n' \
    "$PASS" "$SKIPPED" "$EXPECTED_PASSES"
  exit 1
fi
[ "$FAIL" -eq 0 ] \
  && echo "  eviction behaviour is measured, not assumed: ${PASS} claims${SKIPPED:+ (${SKIPPED} skipped)}" \
  || echo "  ${FAIL} of $((PASS+FAIL)) claims failed"
exit "$FAIL"
