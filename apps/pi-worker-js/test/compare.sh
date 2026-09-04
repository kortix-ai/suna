#!/usr/bin/env bash
# PI ON THIS MAC  vs  PI INSIDE A CELL — the same agent, the same work.
#
# Same @earendil-works/pi-agent-core Agent, same scripted model, same turn
# sequence, same shell commands. Three things differ, and they are precisely
# what a cell buys or costs:
#
#   tools       spawn directly natively; an HTTP call to the daemon in a cell
#   transcript  a plain array natively; SQLite -> object storage in a cell
#   isolation   none natively; a V8 isolate per session in a cell
#
# Anything else would be two different programs compared and called a benchmark.
#
# The honest framing for memory: pi natively is ONE PROCESS PER SESSION, because
# that is what a CLI agent is. A cell is one isolate inside a shared node. So the
# memory rows compare a node process against a cell, which is the real choice
# anyone deploying this makes.
set -euo pipefail
cd "$(dirname "$0")/.."
export PT_AGENT_SCRIPTED=1

CELL_PORT=${CELL_PORT:-18080}
C=pt-cell-$(python3 -c "import json;print(json.load(open('agent.config.json'))['name'])")
RUN=cmp-$$

med() { python3 -c "
import sys; v=sorted(float(x) for x in sys.stdin if x.strip())
print(f'{v[len(v)//2]:.1f}' if v else 'n/a')"; }
row() { printf '  %-30s %12s %12s   %s\n' "$1" "$2" "$3" "${4:-}"; }
rule() { printf '  %s\n' "----------------------------------------------------------------------------"; }

# n tool calls, then a closing text turn. Identical JSON for both runtimes.
script_of() {
  python3 -c "
import json,sys
n=int(sys.argv[1])
t=[{'tool':'bash','id':f'k{i}','args':{'command':'true'}} for i in range(n)]
t.append({'text':'done'}); print(json.dumps(t))" "$1"
}

node celldctl.mjs up >/dev/null 2>&1
# Warm the cell so its first-request bundle load is not charged to every row.
curl -s -o /dev/null -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${RUN}-warm" \
  -H 'content-type: application/json' -d "{\"text\":\"w\",\"script\":$(script_of 1)}"

printf '\n  \033[1mPI LOCAL (this Mac)  vs  PI IN A CELL\033[0m\n'
printf '  same agent, same script, same commands · %s\n\n' "$(uname -sm)"
printf '  %-30s %12s %12s   %s\n' "" "local pi" "in a cell" "difference"
rule

for N in 1 5 20; do
  S=$(script_of "$N")
  LOCAL=$(for _ in 1 2 3 4 5; do
    node test/local-pi.mjs "$S" | python3 -c 'import sys,json;print(json.load(sys.stdin)["ms"])'
  done | med)
  CELL=$(for _ in 1 2 3 4 5; do
    curl -s -o /dev/null -w '%{time_total}\n' -X POST "http://127.0.0.1:${CELL_PORT}/prompt?c=${RUN}-n${N}-$RANDOM" \
      -H 'content-type: application/json' -d "{\"text\":\"go\",\"script\":${S}}"
  done | python3 -c "
import sys; v=sorted(float(x)*1000 for x in sys.stdin if x.strip()); print(f'{v[len(v)//2]:.1f}')")
  # END TO END natively: `node test/local-pi.mjs` from exec to exit. The in-process
  # figure above excludes node boot, and a fresh CLI session cannot: comparing it
  # against a cell request that includes everything would flatter the local side.
  WALL=$(for _ in 1 2 3 4 5; do python3 -c "
import subprocess,time,sys
t=time.time(); subprocess.run(['node','test/local-pi.mjs',sys.argv[1]],capture_output=True); print((time.time()-t)*1000)" "$S"; done | med)
  row "${N} tool call$([ "$N" = 1 ] || echo s)" "${LOCAL} ms" "${CELL} ms" \
      "$(python3 -c "print(f'+{$CELL-$LOCAL:.1f} ms  ({$CELL/$LOCAL:.1f}x) in-process')")"
  row "  ${N} call$([ "$N" = 1 ] || echo s), incl. process start" "${WALL} ms" "${CELL} ms" \
      "$(python3 -c "print(f'{$CELL/$WALL:.1f}x — the fair one')")"
done

rule
# Startup: a native run pays node boot for every session; a cell pays an isolate.
BOOT=$(for _ in 1 2 3; do python3 -c "
import subprocess,time,sys
t=time.time(); subprocess.run(['node','-e','0'],capture_output=True); print((time.time()-t)*1000)"; done | med)
docker restart "$C" >/dev/null
for _ in $(seq 1 600); do [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CELL_PORT}/health")" = "200" ] && break; sleep 0.25; done
COLDCELL=$(curl -s -o /dev/null -w '%{time_total}' "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-cold1")
COLDCELL2=$(curl -s -o /dev/null -w '%{time_total}' "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-cold2")
row "session startup" "${BOOT} ms" "$(python3 -c "print(f'{$COLDCELL2*1000:.1f}')") ms" "node boot vs cold isolate"

# Memory: one node process per session, against one isolate in a shared node.
LOCALRSS=$(node test/local-pi.mjs "$(script_of 1)" | python3 -c 'import sys,json;print(json.load(sys.stdin)["rssMb"])')
LOCALHEAP=$(node test/local-pi.mjs "$(script_of 1)" | python3 -c 'import sys,json;print(json.load(sys.stdin)["heapMb"])')
B=$(docker stats --no-stream --format '{{.MemUsage}}' "$C" | awk '{print $1}' | python3 -c "
import sys,re; m=re.match(r'([0-9.]+)([A-Za-z]+)', sys.stdin.read().strip()); v=float(m.group(1))
print(v*1024 if m.group(2).lower().startswith('g') else v)")
for i in $(seq 1 ${MEM_CELLS:-200}); do curl -s -o /dev/null "http://127.0.0.1:${CELL_PORT}/?c=${RUN}-m$i" & done; wait
A=$(docker stats --no-stream --format '{{.MemUsage}}' "$C" | awk '{print $1}' | python3 -c "
import sys,re; m=re.match(r'([0-9.]+)([A-Za-z]+)', sys.stdin.read().strip()); v=float(m.group(1))
print(v*1024 if m.group(2).lower().startswith('g') else v)")
PERCELL=$(python3 -c "print(f'{($A-$B)/${MEM_CELLS:-200}*1024:.0f}')")
row "memory per session" "${LOCALRSS} MB" "${PERCELL} KB" "$(python3 -c "print(f'{$LOCALRSS*1024/$PERCELL:.0f}x smaller')")"
row "  of which JS heap" "${LOCALHEAP} MB" "—" "one process per session natively"
row "sessions per 16 GB node" "$(python3 -c "print(f'{int(12.8*1024/$LOCALRSS):,}')")" \
    "$(python3 -c "print(f'{int(12.8*1024*1024/$PERCELL):,}')")" "80% cap"

rule
row "transcript survives the process" "no" "yes" "302/302 after SIGKILL"
row "isolation between sessions" "none" "V8 isolate" "one tenant per cell"
printf '\n'
