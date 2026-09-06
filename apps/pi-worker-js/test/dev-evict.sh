#!/usr/bin/env bash
# SCALE TO ZERO, ON THE PLATFORM — the half eviction.sh cannot reach.
#
# eviction.sh proves the whole story on a local Docker node, and every one of
# its claims about a cell being rebuilt ends at a `fresh=false` line in
# `docker logs`. That evidence does not exist on Platinum: a cell runs inside a
# microVM whose celld log is not reachable over the API at all. So "cells scale
# to zero" and "requests are counted for billing" were, on the platform,
# asserted and not proved — and this file is the difference.
#
# What makes it possible is that the cell now counts its own rebuilds. `builds`
# is bumped in init(), which this.ready guards, so it advances exactly once per
# isolate; it lives in the same SQLite that LTX replicates to the bucket, so it
# comes back with the cell. `instance` is the opposite by construction: memory
# only, so it must change when `builds` moves. Reading the two together over
# HTTP says what the log used to say, from outside.
#
# Measured on dev 2026-09-06, CELLD_IDLE_EVICT_S=30 with an 80 s idle window:
# create->running 1154 ms, serving 902 ms later, and the first request after
# the cell had gone to zero answered in 463 ms.
#
# Needs a Platinum dev token (PT_SANDBOX_KEY, or ~/.config/platinum/credentials)
# and the current bundle deployed to the pi-agent worker. Cleans up its cell.
set -uo pipefail
cd "$(dirname "$0")/.."
API=${PT_API_URL:-https://api-dev.platinum.dev}
TOK=${PT_SANDBOX_KEY:-$(grep -E '^default[[:space:]]*=' ~/.config/platinum/credentials 2>/dev/null | sed -E 's/^default[[:space:]]*=[[:space:]]*"?//; s/"?[[:space:]]*$//')}
[ -n "$TOK" ] || { echo "  SKIP: no Platinum dev token (PT_SANDBOX_KEY or ~/.config/platinum/credentials)"; exit 0; }
H=(-H "Authorization: Bearer $TOK" -H 'content-type: application/json')
PASS=0; FAIL=0
pass(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
CELL=""
cleanup(){ [ -n "$CELL" ] && curl -s -m 90 -o /dev/null -X DELETE "$API/v1/sandboxes/$CELL" "${H[@]}" && echo "  cleanup: $CELL"; }
trap cleanup EXIT

# The TEMPLATE sets 300 s, which is the right default for a session and far too
# long for a test. A sandbox-level env overrides it, and that override is itself
# part of what this proves: the knob reaches celld on the platform.
IDLE=${IDLE_S:-30}
BODY=$(IDLE="$IDLE" python3 -c "
import json, os
print(json.dumps({'template':'pt-celld','runtime':'cell','worker':'pi-agent','name':'evict-proof','cpu':2,'ram_mb':4096,
 'expose':[{'port':8080,'public':True}],
 'env':{'CELLD_IDLE_EVICT_S':os.environ['IDLE'],'CELLD_VAR_PT_AGENT_SCRIPTED':'1'}}))")
t=$(ms)
CELL=$(curl -s -m 300 "${H[@]}" -X POST "$API/v1/sandboxes?wait_for_state=running&wait_timeout_ms=240000" -d "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$CELL" ] || { echo "  SKIP: could not create a cell on dev (capacity?)"; exit 0; }
echo "  cell $CELL create->running $(( $(ms) - t )) ms  (CELLD_IDLE_EVICT_S=$IDLE)"

URL="https://8080-$(echo "${CELL#sbx_}" | tr 'A-Z' 'a-z').eu-west.sbx-dev.platinum.dev"
t=$(ms); code=000
for _ in $(seq 1 300); do code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$URL/health"); case "$code" in 2*) break;; esac; sleep 0.2; done
SERVE=$(( $(ms) - t ))
[ "$code" = 200 ] && pass "the cell serves HTTP ($code after ${SERVE} ms)" || { fail "cell never served: $code"; exit 1; }

SESS="evict-$RANDOM"
mread(){ curl -s -m 20 "$URL/meter?c=$SESS" | python3 -c 'import json,sys;d=json.load(sys.stdin);m=d["meters"];print(m.get("requests",0),m.get("builds",0),d.get("instance",""),d.get("instanceAgeMs",0))' 2>/dev/null || echo "0 0  0"; }
for i in 1 2 3 4 5; do curl -s -o /dev/null -m 20 "$URL/history?c=$SESS"; done
read -r R1 B1 I1 A1 <<<"$(mread)"
echo "  before idle: requests=$R1 builds=$B1 instance=$I1 age=${A1}ms"
[ "${B1:-0}" -ge 1 ] && pass "a fresh cell on the platform reports builds=$B1" || fail "builds absent on the platform: '$B1' — is the current bundle deployed to pi-agent?"
[ "${R1:-0}" -ge 5 ] && pass "the meter counted its requests ($R1)" || fail "meter did not count: $R1"

WAIT=$(( IDLE * 2 + 20 ))
echo "  idling ${WAIT}s (no request reaches the cell)"
sleep "$WAIT"

t=$(ms); read -r R2 B2 I2 A2 <<<"$(mread)"; WAKE=$(( $(ms) - t ))
echo "  after idle:  requests=$R2 builds=$B2 instance=$I2 age=${A2}ms  (that read took ${WAKE} ms)"
[ "${B2:-0}" -gt "${B1:-0}" ] \
  && pass "SCALE TO ZERO ON THE PLATFORM: the cell was evicted and rebuilt (builds $B1 -> $B2)" \
  || fail "the cell was never evicted on the platform after ${WAIT}s idle (builds $B1 -> $B2)"
[ -n "$I1" ] && [ "$I1" != "$I2" ] \
  && pass "a DIFFERENT isolate serves the same cell ($I1 -> $I2)" \
  || fail "same isolate after the idle window ($I1 -> $I2)"
# /meter is an UNBILLED path, so the read above cannot have moved the count.
# That is the point: the number the control plane differences must not depend on
# how often it is read. So the claim is exact — the rebuilt cell reports the
# SAME total, and the next BILLED request takes it to exactly one more.
[ "${R2:-0}" -eq "${R1:-0}" ] \
  && pass "REQUEST COUNTING SURVIVED IT: requests $R1 -> $R2 across the rebuild, and reading the meter did not move it" \
  || fail "the meter changed across a rebuild it should have survived unchanged: $R1 -> $R2"
curl -s -o /dev/null -m 20 "$URL/history?c=$SESS"
read -r R3 B3 I3 _ <<<"$(mread)"
[ "${R3:-0}" -eq "$(( R2 + 1 ))" ] && [ "${B3:-0}" -eq "${B2:-0}" ] \
  && pass "and it carries on from there: one billed request after the rebuild reads $R3, on the same isolate (builds still $B3)" \
  || fail "the count did not resume at $(( R2 + 1 )): requests=$R3 builds=$B3 (was $R2/$B2)"
[ "${A2:-99999999}" -lt "$(( WAIT * 1000 ))" ] \
  && pass "and the new isolate is younger than the idle window (${A2} ms < ${WAIT}000 ms)" \
  || fail "the isolate is as old as the cell (${A2} ms) — it never went away"
echo "  wake-from-zero: ${WAKE} ms"

EXPECTED_PASSES=8
echo
if [ "$FAIL" -gt 0 ]; then
  printf '  \033[31m%d claim(s) failed\033[0m\n' "$FAIL"
elif [ "$PASS" -ne "$EXPECTED_PASSES" ]; then
  printf '  \033[31mINCOMPLETE\033[0m %d claims ran, expected %d\n' "$PASS" "$EXPECTED_PASSES"; FAIL=1
else
  printf '  cells scale to zero on the platform and the meter survives it: %d claims\n' "$PASS"
fi
exit "$FAIL"
