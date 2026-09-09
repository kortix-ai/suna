#!/usr/bin/env bash
# WHAT ONE CELL COSTS IN MEMORY, measured instead of repeated.
#
# The comparison this effort is judged against claims 1.38 MiB/instance against
# agentOS's ~131 MB, and that number appears nowhere in this repo — it has been
# restated all session without evidence. A cell sandbox refuses `exec`
# ("runtime_capability_unsupported"), so RSS is not readable from inside; the
# platform's own /metrics reports the box's `mem_used_mb`, which is the same
# question asked from outside. Spawn N isolates on a box with nothing else on
# it, read it again, take the slope. `/turns` rather than `/ping`, because /ping
# answers BEFORE init() and an isolate that never built its schema is not a
# session — the first run of this measured those and found nothing, which is
# true and not the question.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH
API=https://api-dev.platinum.dev
TOK=$(sed -n 's/^default = //p' ~/.config/platinum/credentials | head -1)
H=(-H "Authorization: Bearer $TOK" -H 'content-type: application/json')
ID=""
cleanup(){ [ -n "$ID" ] && curl -s -m 90 -o /dev/null -X DELETE "$API/v1/sandboxes/$ID" "${H[@]}"; echo "  cleaned up $ID"; }
trap cleanup EXIT
mem(){ curl -s -m 20 -H "Authorization: Bearer $TOK" "$API/v1/sandboxes/$ID/metrics" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("mem_used_mb","?"))'; }
B=$(python3 -c "import json;print(json.dumps({'template':'pt-celld','runtime':'cell','worker':'pi-agent','name':'per-instance','cpu':4,'ram_mb':8192,'expose':[{'port':8080,'public':True}]}))")
ID=$(curl -s -m 300 "${H[@]}" -X POST "$API/v1/sandboxes?wait_for_state=running&wait_timeout_ms=240000" -d "$B" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -n "$ID" ] || { echo "  create failed"; exit 1; }
U="https://8080-$(echo "${ID#sbx_}" | tr 'A-Z' 'a-z').eu-west.sbx-dev.platinum.dev"
for _ in $(seq 1 400); do [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$U/health")" = 200 ] && break; sleep 0.25; done
echo "  probe box $ID (4 cpu, 8 GiB, nothing else on it)"
# REFUSE TO MEASURE NOTHING. mem_used_mb is null on a box the sampler has not
# reached yet, and a run that reports "None MB" four times has measured nothing
# while looking like it worked.
for i in $(seq 1 60); do
  [ "$(mem)" != "None" ] && { echo "  metrics live after ${i}0s"; break; }
  sleep 10
done
[ "$(mem)" != "None" ] || { echo "  FAIL metrics never reported memory for this box"; exit 1; }
NONCE=$$-$(date +%s)
BASE=$(mem); echo "  N=0     mem_used ${BASE} MB   <- the node itself"
DONE=0
for N in 100 200 400; do
  python3 - "$U" "$NONCE" "$DONE" "$N" <<'PY'
import sys, urllib.request, concurrent.futures
u, nonce, lo, hi = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def touch(i):
    try: urllib.request.urlopen(f"{u}/turns?c=inst-{nonce}-{i}", timeout=25).read()
    except Exception: pass
with concurrent.futures.ThreadPoolExecutor(max_workers=24) as ex:
    list(ex.map(touch, range(lo, hi)))
PY
  DONE=$N
  # LET THE SAMPLER CATCH UP. Reading immediately after a spawn reported 486 MB
  # for N=50, 100 and 200 and then 1146 MB for N=400 — a step function that is
  # the sampler's lag, not the memory's shape. Two equal reads 20 s apart is the
  # value having settled.
  prev=""; CUR=$(mem)
  for _ in $(seq 1 12); do
    sleep 20; prev=$CUR; CUR=$(mem)
    [ "$CUR" = "$prev" ] && break
  done
  python3 -c "
base, cur, n = $BASE, $CUR, $N
print('  N=%-5d mem_used %s MB   (+%s MB over the node, %.2f MiB per instance)' % (n, cur, cur-base, (cur-base)*1024/n/1024*1024/1024))" 2>/dev/null \
  || echo "  N=$N mem_used $CUR MB"
done
echo "  --- are they still resident? (a fresh name would report ageMs ~0)"
curl -s -m 20 "$U/ping?c=inst-$NONCE-1" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("   first isolate ageMs", d.get("ageMs"))'
