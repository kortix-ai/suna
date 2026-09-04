#!/usr/bin/env bash
# WHAT DOES A CELL ACTUALLY COST? Measured, on the pinned celld 0.3.0.
#
# The published estimates for this design are engineering arithmetic — nobody had
# benchmarked pi-in-a-cell. These are the numbers that can be measured from
# outside without a model in the loop, which is the point: every figure below is
# something the platform controls, and the LLM turn (2-30 s) dwarfs all of them.
# That is the finding, not a caveat.
#
# Measured on one laptop against Docker + MinIO on loopback. Treat them as an
# ORDER OF MAGNITUDE and a RATIO to each other, not as production numbers: a real
# deployment has a network between the cell and its bucket, and between the cell
# and the daemon.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pin the model to the scripted one for the whole run. Without this the suite
# uses whatever agent.config.json points at, so the moment anyone logs in to a
# real provider these claims stop being deterministic and start costing money.
export PT_AGENT_SCRIPTED=1

CELL_PORT=${CELL_PORT:-18080}
DAEMON_PORT=${DAEMON_PORT:-7070}
MINIO_PORT=${MINIO_PORT:-19000}
TOKEN=${TOKEN:-dev-token}
NODE_ID=${NODE_ID:-agent-node-0}
RUN=bench-$$

ms() { python3 -c "import sys;print(f'{float(sys.argv[1])*1000:.0f}', end='')" "$1"; }
t_cell() { curl -s -o /dev/null -w '%{time_total}' -m 120 "http://127.0.0.1:${CELL_PORT}$1" "${@:2}"; }
row() { printf '  %-46s %8s ms\n' "$1" "$2"; }

start_node() {
  docker rm -f pt-cell >/dev/null 2>&1 || true
  docker run -d --name pt-cell --platform linux/amd64 -p "${CELL_PORT}:8080" \
    -e AWS_ACCESS_KEY_ID=celldev -e AWS_SECRET_ACCESS_KEY=celldev123 -e AWS_REGION=us-east-1 \
    -e "CELLD_NODE=${NODE_ID}" --add-host=host.docker.internal:host-gateway \
    pt-celld:0.3.0 celld --bucket s3://cells/orgs/demo \
      --endpoint "http://host.docker.internal:${MINIO_PORT}" --region us-east-1 \
      --listen 0.0.0.0:8080 --internal-listen 0.0.0.0:8090 --advertise 127.0.0.1:8090 >/dev/null
}
wait_serving() {
  for _ in $(seq 1 600); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CELL_PORT}/health" 2>/dev/null)" = "200" ] && return 0
    sleep 0.25
  done
  return 1
}

echo "== node spawn =="
T0=$(python3 -c 'import time;print(time.time())')
start_node
wait_serving || { echo "node never served"; exit 1; }
T1=$(python3 -c 'import time;print(time.time())')
row "celld process start -> first 200 /health" "$(python3 -c "print(f'{($T1-$T0)*1000:.0f}')")"

echo
echo "== request latency (no model, no tool) =="
# Discard the first: it pays for the isolate AND the cell's first storage open.
t_cell "/?c=${RUN}-warm" >/dev/null
for i in 1 2 3; do :; done
WARM=$(for i in 1 2 3 4 5; do t_cell "/?c=${RUN}-warm"; echo; done | python3 -c "
import sys; v=sorted(float(x) for x in sys.stdin if x.strip()); print(f'{v[len(v)//2]*1000:.0f}')")
row "warm request to a live cell (median of 5)" "$WARM"

COLD=$(t_cell "/?c=${RUN}-cold-1")
row "FIRST request to a never-seen cell (cold isolate)" "$(ms "$COLD")"

echo
echo "== the daemon hop, which is what a tool costs =="
DIRECT=$(curl -s -o /dev/null -w '%{time_total}' -m 30 \
  -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' \
  -d "{\"opId\":\"bench-direct-$$\",\"sessionId\":\"${RUN}\",\"command\":\"true\"}" \
  "http://127.0.0.1:${DAEMON_PORT}/exec")
row "daemon /exec called directly (baseline)" "$(ms "$DIRECT")"

ONE=$(t_cell "/prompt?c=${RUN}-t1" -X POST -H 'content-type: application/json' \
  -d '{"text":"go","script":[{"tool":"bash","id":"bo1","args":{"command":"true"}},{"text":"ok"}]}')
row "prompt: 1 bash call, cold cell, end to end" "$(ms "$ONE")"

FIVE=$(t_cell "/prompt?c=${RUN}-t5" -X POST -H 'content-type: application/json' \
  -d '{"text":"go","script":[
    {"tool":"bash","id":"b1","args":{"command":"true"}},
    {"tool":"bash","id":"b2","args":{"command":"true"}},
    {"tool":"bash","id":"b3","args":{"command":"true"}},
    {"tool":"bash","id":"b4","args":{"command":"true"}},
    {"tool":"bash","id":"b5","args":{"command":"true"}},
    {"text":"ok"}]}')
row "prompt: 5 sequential bash calls, one cell" "$(ms "$FIVE")"

echo
echo "== transcript restore: storage is truth, so every request pays this =="
for N in 20 100 300; do
  S="${RUN}-n${N}"
  # Fill the transcript with real turns rather than synthetic rows, so the cost
  # measured is the cost the agent actually pays: JSON.parse of pi messages.
  BODY=$(python3 -c "
import json,sys
n=int(sys.argv[1])
turns=[]
for i in range(n//2):
    turns.append({'tool':'bash','id':f'f{i}','args':{'command':'true'}})
turns.append({'text':'done'})
print(json.dumps({'text':'fill','script':turns}))" "$N")
  curl -s -o /dev/null -m 300 "http://127.0.0.1:${CELL_PORT}/prompt?c=${S}" \
    -X POST -H 'content-type: application/json' -d "$BODY"
  COUNT=$(curl -s "http://127.0.0.1:${CELL_PORT}/?c=${S}" | python3 -c "import sys,json;print(json.load(sys.stdin)['messages'])")
  T=$(for i in 1 2 3; do t_cell "/?c=${S}"; echo; done | python3 -c "
import sys; v=sorted(float(x) for x in sys.stdin if x.strip()); print(f'{v[len(v)//2]*1000:.0f}')")
  row "read a ${COUNT}-message transcript (median of 3)" "$T"
done

echo
echo "== resume: the cost of losing the node =="
BEFORE=$(curl -s "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-n300" | python3 -c "import sys,json;print(json.load(sys.stdin)['messages'])")
docker kill pt-cell >/dev/null
T0=$(python3 -c 'import time;print(time.time())')
start_node
wait_serving || { echo "replacement never served"; exit 1; }
T1=$(python3 -c 'import time;print(time.time())')
row "SIGKILL -> replacement node serving /health" "$(python3 -c "print(f'{($T1-$T0)*1000:.0f}')")"
FIRST=""
for _ in $(seq 1 80); do
  FIRST=$(t_cell "/?c=${RUN}-n300" 2>/dev/null || echo "")
  OUT=$(curl -s "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-n300" | python3 -c "import sys,json;print(json.load(sys.stdin)['messages'])" 2>/dev/null || echo "")
  [ -n "$OUT" ] && break
  sleep 0.25
done
row "first read of that cell after the kill" "$(ms "${FIRST:-0}")"
printf '  %-46s %8s\n' "messages recovered (was ${BEFORE})" "${OUT:-none}"
[ "$OUT" = "$BEFORE" ] || { echo "  TRANSCRIPT LOSS — ${BEFORE} before, ${OUT} after"; exit 1; }

echo
echo "== size =="
printf '  %-46s %8s KB\n' "worker bundle (pi-agent-core + tools)" "$(( $(wc -c < dist/worker.js) / 1024 ))"
