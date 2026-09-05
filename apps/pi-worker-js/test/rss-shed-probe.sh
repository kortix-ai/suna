#!/bin/bash
# MANUAL PROBE, not a suite: what CELLD_MAX_RSS_MB does on celld 0.3.0.
#
# Measured 2026-09-05: cap 1600 MB → at rest 70 MB, 40 sessions → 168 MB, re-touched
# warm → 0 rebuilds. Cap 110 MB → one `shedding reason="memory"` and the node is
# WEDGED: /health 200 in 3 ms, every cell request hangs (500 after 15 s) for 12+ min.
# That is why the platform template sets no cap (an OOM-killed celld is restarted
# by the entrypoint; a shed wedge is never noticed). Re-run against a newer celld
# before putting the cap back. Usage: test/rss-shed-probe.sh <cap_mb> [sessions]
# $1 = CELLD_MAX_RSS_MB cap, $2 = sessions. Prints RSS at rest, after load, and how many warm scopes got rebuilt when re-touched.
cd ~/dev/suna/apps/pi-worker-js; CAP=$1; N=${2:-40}; PORT=18080
node celldctl.mjs down >/dev/null 2>&1
CELLD_MAX_RSS_MB=$CAP PT_AGENT_SCRIPTED=1 node celldctl.mjs up >/dev/null 2>&1 || { echo "node up failed"; exit 1; }
CELL=$(docker ps --filter name=pt-cell --format '{{.Names}}' | head -1); sleep 2
rss() { docker stats --no-stream --format '{{.MemUsage}}' "$CELL" | cut -d/ -f1 | tr -d ' '; }
echo "cap=${CAP}MB node=$CELL rss at rest: $(rss)"
scopes() { docker logs "$CELL" 2>&1 | grep -oE "scope=AgentCell:[a-f0-9]{64}" | sort -u; }
for i in $(seq 1 $N); do curl -s -o /dev/null -m 10 -X POST -H 'content-type: application/json' -d "{\"text\":\"hello $i $(head -c 3000 /dev/zero | tr '\0' 'x')\"}" "http://127.0.0.1:${PORT}/prompt?c=rss-$i-$$"; done
sleep 3; echo "after $N sessions: rss $(rss), scopes $(scopes | wc -l | tr -d ' ')"
F0=$(docker logs "$CELL" 2>&1 | grep -c 'fresh=false')
for i in $(seq 1 $N); do curl -s -o /dev/null -m 10 "http://127.0.0.1:${PORT}/history?c=rss-$i-$$"; done
sleep 3; F1=$(docker logs "$CELL" 2>&1 | grep -c 'fresh=false')
echo "re-touched all $N while warm: rebuilt-from-storage lines $F0 -> $F1 (delta $((F1-F0))); rss $(rss); evict/shed log lines: $(docker logs "$CELL" 2>&1 | grep -ciE 'evict|shed|rss')"
docker logs "$CELL" 2>&1 | grep -iE 'evict|shed|rss' | tail -3 | cut -c1-200
node celldctl.mjs down >/dev/null 2>&1
