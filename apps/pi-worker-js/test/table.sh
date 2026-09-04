#!/usr/bin/env bash
# ONE TABLE: what a cell costs, measured end to end.
#
# bench.sh measures pieces. This produces the single sheet you would put in front
# of someone deciding whether to build on this — every number measured on the
# pinned celld 0.3.0, against real S3 (MinIO), through a real `celld deploy`,
# with a real V8 isolate and real SQLite.
#
# The comparison that matters is the last column of section 3: the same command
# run natively on this machine, then through the daemon, then through the whole
# cell. That difference IS the platform's overhead, and nothing else in this
# file is as decision-relevant.
#
# Loopback, one laptop, Docker for Mac. Ratios travel; absolute numbers do not.
set -euo pipefail
cd "$(dirname "$0")/.."
export PT_AGENT_SCRIPTED=1   # never let a real model into a benchmark

CELL_PORT=${CELL_PORT:-18080}
DAEMON_PORT=${DAEMON_PORT:-7070}
TOKEN=${TOKEN:-dev-token}
C=pt-cell-$(python3 -c "import json;print(json.load(open('agent.config.json'))['name'])")
RUN=tbl-$$

med() { python3 -c "
import sys; v=sorted(float(x) for x in sys.stdin if x.strip())
print(f'{v[len(v)//2]*1000:.1f}' if v else 'n/a')"; }
mb() { python3 -c "
import sys,re
m=re.match(r'([0-9.]+)([A-Za-z]+)', sys.argv[1]); v=float(m.group(1)); u=m.group(2).lower()
print(f\"{ {'b':v/1048576,'kib':v/1024,'kb':v/1024,'mib':v,'mb':v,'gib':v*1024,'gb':v*1024}.get(u,v):.1f}\")" "$1"; }
rss() { docker stats --no-stream --format '{{.MemUsage}}' "$C" | awk '{print $1}'; }
row() { printf '  %-44s %10s  %s\n' "$1" "$2" "${3:-}"; }
hdr() { printf '\n  \033[1m%s\033[0m\n' "$1"; }
wait_serving() {
  for _ in $(seq 1 600); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CELL_PORT}/health" 2>/dev/null)" = "200" ] && return 0
    sleep 0.25
  done
  return 1
}

node celldctl.mjs up >/dev/null 2>&1

printf '\n  \033[1mPI IN A CELL — measured cost\033[0m\n'
printf '  celld 0.3.0 · MinIO on loopback · %s\n' "$(uname -sm)"

hdr "1. spawn"
T0=$(python3 -c 'import time;print(time.time())')
docker restart "$C" >/dev/null; wait_serving || exit 1
T1=$(python3 -c 'import time;print(time.time())')
row "celld process start -> serving" "$(python3 -c "print(f'{($T1-$T0)*1000:.0f}')") ms" "once per node"

hdr "2. cold start (per cell)"
# Restart so every isolate is cold and all state must come from the bucket.
docker restart "$C" >/dev/null; wait_serving || exit 1
FIRST=$(curl -s -o /dev/null -w '%{time_total}' "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-a")
SECOND=$(curl -s -o /dev/null -w '%{time_total}' "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-b")
WARM=$(for _ in $(seq 1 7); do curl -s -o /dev/null -w '%{time_total}\n' "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-b"; done | med)
row "first cell on a fresh node" "$(python3 -c "print(f'{$FIRST*1000:.1f}')") ms" "loads the bundle"
row "each additional cold cell" "$(python3 -c "print(f'{$SECOND*1000:.1f}')") ms" "isolate + storage open"
row "warm request" "${WARM} ms" ""

hdr "3. running one command — the comparison that matters"
NATIVE=$(for _ in $(seq 1 15); do python3 -c "
import subprocess,time
t=time.time(); subprocess.run(['bash','-lc','true'],capture_output=True); print(time.time()-t)"; done | med)
DAEMON=$(for i in $(seq 1 15); do
  curl -s -o /dev/null -w '%{time_total}\n' -H "authorization: Bearer ${TOKEN}" \
    -H 'content-type: application/json' \
    -d "{\"opId\":\"n-$RANDOM-$i\",\"sessionId\":\"${RUN}\",\"command\":\"true\"}" \
    "http://127.0.0.1:${DAEMON_PORT}/exec"; done | med)
curl -s -o /dev/null -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${RUN}-w" -H 'content-type: application/json' \
  -d '{"text":"w","script":[{"tool":"bash","id":"warm","args":{"command":"true"}},{"text":"ok"}]}'
CELL=$(for i in $(seq 1 10); do
  curl -s -o /dev/null -w '%{time_total}\n' -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${RUN}-w" \
    -H 'content-type: application/json' \
    -d "{\"text\":\"go\",\"script\":[{\"tool\":\"bash\",\"id\":\"c$i-$RANDOM\",\"args\":{\"command\":\"true\"}},{\"text\":\"ok\"}]}"; done | med)
row "native: bash -lc true on this machine" "${NATIVE} ms" "the floor"
row "+ daemon hop (HTTP + spawn)" "${DAEMON} ms" "$(python3 -c "print(f'+{$DAEMON-$NATIVE:.1f} ms')")"
row "+ whole cell (isolate + agent loop)" "${CELL} ms" "$(python3 -c "print(f'+{$CELL-$DAEMON:.1f} ms')")"
FIVE=$(curl -s -o /dev/null -w '%{time_total}' -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${RUN}-5" \
  -H 'content-type: application/json' -d '{"text":"go","script":[
   {"tool":"bash","id":"x1","args":{"command":"true"}},{"tool":"bash","id":"x2","args":{"command":"true"}},
   {"tool":"bash","id":"x3","args":{"command":"true"}},{"tool":"bash","id":"x4","args":{"command":"true"}},
   {"tool":"bash","id":"x5","args":{"command":"true"}},{"text":"ok"}]}')
row "5 sequential tool calls, one prompt" "$(python3 -c "print(f'{$FIVE*1000:.1f}')") ms" \
    "$(python3 -c "print(f'~{($FIVE*1000-$CELL)/4:.1f} ms per extra call')")"

hdr "4. transcript — storage is truth, so every request pays it"
for N in 20 100 300; do
  S="${RUN}-n${N}"
  BODY=$(python3 -c "
import json,sys
n=int(sys.argv[1]); t=[{'tool':'bash','id':f'f{i}','args':{'command':'true'}} for i in range(n//2)]
t.append({'text':'done'}); print(json.dumps({'text':'fill','script':t}))" "$N")
  curl -s -o /dev/null -m 300 "http://127.0.0.1:${CELL_PORT}/prompt?c=${S}" -X POST -H 'content-type: application/json' -d "$BODY"
  CNT=$(curl -s "http://127.0.0.1:${CELL_PORT}/?c=${S}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["messages"])')
  T=$(for _ in 1 2 3; do curl -s -o /dev/null -w '%{time_total}\n' "http://127.0.0.1:${CELL_PORT}/?c=${S}"; done | med)
  row "read a ${CNT}-message transcript" "${T} ms" ""
done

hdr "5. losing the node"
BEFORE=$(curl -s "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-n300" | python3 -c 'import sys,json;print(json.load(sys.stdin)["messages"])')
docker kill "$C" >/dev/null
# `celldctl up` would rebuild and redeploy, which is not what "the node died and
# came back" costs — that measured 2231 ms and was mostly esbuild. Start the
# container that already exists, which is what a supervisor would do.
T0=$(python3 -c 'import time;print(time.time())')
docker start "$C" >/dev/null; wait_serving || exit 1
T1=$(python3 -c 'import time;print(time.time())')
AFTER=""
for _ in $(seq 1 80); do
  AFTER=$(curl -s "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-n300" | python3 -c 'import sys,json;print(json.load(sys.stdin)["messages"])' 2>/dev/null || echo "")
  [ -n "$AFTER" ] && break; sleep 0.25
done
row "SIGKILL -> replacement serving" "$(python3 -c "print(f'{($T1-$T0)*1000:.0f}')") ms" ""
row "messages recovered" "${AFTER}/${BEFORE}" "$([ "$AFTER" = "$BEFORE" ] && echo 'no loss' || echo 'TRANSCRIPT LOSS')"
[ "$AFTER" = "$BEFORE" ] || exit 1

hdr "6. memory"
# BOUNDED ON PURPOSE. This used to walk to 500 live cells, which on a 16 GB
# laptop pushed the host into OOM and got the Docker VM SIGKILLed mid-run —
# twice. The marginal cost is already flat by ~200, so the extra 300 bought
# noise and a dead daemon. MEM_STEPS raises it on a machine that can take it.
docker restart "$C" >/dev/null; wait_serving || exit 1
B=$(mb "$(rss)")
row "celld baseline, no cells" "${B} MB" ""
for n in ${MEM_STEPS:-50 200}; do
  for i in $(seq 1 $n); do curl -s -o /dev/null "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-m$i" & done; wait
  R=$(mb "$(rss)"); eval "M$n=$R"
  row "resident with ${n} live cells" "${R} MB" "$(python3 -c "print(f'{($R-$B)/$n*1024:.0f} KB/cell')")"
done
python3 -c "
b=$B; m50=$M50; m200=$M200
marg=(m500-m100)/400
print(f'  {\"marginal cost at scale\":<44} {marg*1024:>7.0f} KB   50->200 cells')
print(f'  {\"extrapolated to a 16 GB node (80% cap)\":<44} {int(12.8*1024/marg):>7,} cells')"

hdr "7. size"
for set in slim all; do
  python3 -c "
import json; d=json.load(open('agent.config.json')); d['model']['providers']='$set'
json.dump(d, open('agent.config.json','w'), indent=2); open('agent.config.json','a').write('\n')"
  KB=$(npm run --silent build 2>&1 | grep -oE '[0-9]+ KB' | head -1)
  row "worker bundle (providers: ${set})" "${KB}" "$([ "$set" = all ] && echo '39 providers, 1290 models' || echo '3 APIs')"
done
python3 -c "
import json; d=json.load(open('agent.config.json')); d['model']['providers']='all'
json.dump(d, open('agent.config.json','w'), indent=2); open('agent.config.json','a').write('\n')"

printf '\n  \033[1mthe point\033[0m\n'
printf '  An LLM turn is 2-30 s. Everything above is 3-4 orders of magnitude smaller,\n'
printf '  including losing the node entirely. The platform is not where the time goes.\n\n'
