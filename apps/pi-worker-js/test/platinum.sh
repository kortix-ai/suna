#!/usr/bin/env bash
# THE PLATINUM TOOL BACKEND — claims 9 and 10, in their own script.
#
# Split out of e2e.sh deliberately. Together the two suites restart the cell
# node five times, run a second HTTP service and churn containers throughout,
# and the local Docker VM was dying partway through — every time at the first
# platinum claim, which made it look like that claim was at fault. It was not:
# the same claims pass on their own, repeatedly.
#
# So the default suite stays light and this runs when you want it. That is also
# the honest shape: claims 1-8 need only a cell, and these two need a stand-in
# for a control plane.
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
export PT_AGENT_SCRIPTED=1

CELL_PORT=${CELL_PORT:-18080}
MINIO_PORT=${MINIO_PORT:-19000}
BUCKET=${BUCKET:-cells}
PREFIX=${PREFIX:-orgs/demo}
SESSION=plat-$$

PASS=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }
cell()   { curl -s -m 60 "http://127.0.0.1:${CELL_PORT}$1" "${@:2}"; }
pyjson() { python3 -c "import sys,json;d=json.loads(sys.stdin.read(),strict=False);$1"; }
start_cell() { node celldctl.mjs up >/dev/null 2>&1; }

cleanup() {
  node celldctl.mjs down >/dev/null 2>&1 || true
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null || true
  free_port 7098
}
trap cleanup EXIT

echo "== 1. the PLATINUM tool backend: the platform's own API =="
# The daemon was a parallel exec service next to one the platform already has.
# These claims drive the real routes — /exec, /files, /files/list, /files/grep —
# against test/platinum-stub.mjs, which implements the contracts as
# apps/api/src/api/sandboxes.ts defines them (cmd as string OR argv, timeout_ms
# not seconds, the command's own failure inside `result`, `..` rejected).
free_port 7098
rm -rf /tmp/platinum-stub-work
SANDBOX_ID=sbx_workspace SANDBOX_KEY=pt_live_stubkey PORT=7098 node test/platinum-stub.mjs >/tmp/stub.log 2>&1 &
STUB_PID=$!
for _ in $(seq 1 40); do grep -q 'platinum-stub' /tmp/stub.log 2>/dev/null && break; sleep 0.1; done

export PT_API_URL=http://host.docker.internal:7098
export PT_SANDBOX_KEY=pt_live_stubkey
export PT_WORKSPACE_ID=sbx_workspace
# Where commands run inside the sandbox. In a real sandbox this is /home/user
# in the VM; the stub executes on the host, so it is the stub's work root.
# Without it every bash call is `cd /home/user && ...` on a host that has no
# such directory, and only the shell-backed operations fail — the file routes
# keep working, which makes it look like a bash bug rather than a cwd one.
export PT_WORKSPACE_CWD=/tmp/platinum-stub-work
start_cell || fail "cell did not come up on the platinum backend"
BACKEND=$(cell "/model?c=x" | pyjson "print(d['tools']['backend'])")
[ "$BACKEND" = "platinum" ] || fail "backend is ${BACKEND}, not platinum"

PS="${SESSION}-plat"
cell "/prompt?c=${PS}" -X POST -H 'content-type: application/json' -d '{
 "text":"exercise","script":[
  {"tool":"write","id":"pw1","args":{"path":"src/app.py","content":"import os\nSECRET_MARKER = 1\nprint(\"hi\")"}},
  {"tool":"bash","id":"pb1","args":{"command":"python3 src/app.py"}},
  {"tool":"read","id":"pr1","args":{"path":"src/app.py","offset":2,"limit":1}},
  {"tool":"list","id":"pl1","args":{"path":"/"}},
  {"tool":"grep","id":"pg1","args":{"pattern":"SECRET_MARKER"}},
  {"text":"done"}]}' >/dev/null
# pi's read tool numbers lines from 1, and treats offset 0 as 1 — the
# hand-rolled tool it replaced was 0-based, so the same arguments now mean a
# different line.
RES=$(cell "/history?c=${PS}" | pyjson "
out=[]
for m in d['messages']:
    if m['role']=='toolResult':
        c=m['message'].get('content') or [{}]
        out.append((c[0].get('text') or '').strip().replace(chr(10),' '))
print('|'.join(out))")
# Claimed per tool rather than as one exact string. The exact-match version of
# this assertion held the OLD hand-rolled tools' wording and kept failing as a
# single opaque blob after the switch to pi's tools, which said nothing about
# which of the five was wrong.
part() { echo "$RES" | cut -d'|' -f"$1"; }
case "$(part 1)" in *"src/app.py"*) pass "write went through Platinum's API" ;;
  *) fail "write: $(part 1)" ;; esac
case "$(part 2)" in *"hi"*) pass "bash ran python3 in the workspace cwd" ;;
  *) fail "bash: $(part 2)" ;; esac
case "$(part 3)" in *"SECRET_MARKER = 1"*) pass "read returned the addressed line" ;;
  *) fail "read: $(part 3)" ;; esac
case "$(part 4)" in *"src"*) pass "list saw the directory" ;;
  *) fail "list: $(part 4)" ;; esac
case "$(part 5)" in *"app.py:2:SECRET_MARKER"*) pass "grep found the match with a line number" ;;
  *) fail "grep: $(part 5)" ;; esac

echo "== 2. a sandbox-scoped key cannot reach another sandbox =="
# sandboxScope.ts exists so an agent can be handed a credential that "cannot
# touch the rest of the org". Point the cell at a different sandbox id and the
# platform refuses — and the op ledger records the failure rather than losing it.
export PT_WORKSPACE_ID=sbx_someone_else
start_cell || fail "cell did not restart"
CS2="${SESSION}-confine"
cell "/prompt?c=${CS2}" -X POST -H 'content-type: application/json' \
  -d '{"text":"try","script":[{"tool":"bash","id":"cf1","args":{"command":"echo SHOULD_NOT_RUN"}},{"text":"done"}]}' >/dev/null
REFUSAL=$(cell "/history?c=${CS2}" | pyjson "
out=''
for m in d['messages']:
    if m['role']=='toolResult':
        c=m['message'].get('content') or [{}]
        out=(c[0].get('text') or '')
print(out[:120])")
LEDGER=$(cell "/ops?c=${CS2}" | pyjson "print(','.join(o['status'] for o in d['ops']))")
case "$REFUSAL" in
  *sandbox_scope*) [ "$LEDGER" = "error" ] \
      && pass "refused with the platform's own sandbox_scope, and the op is recorded failed" \
      || fail "refused, but the ledger says '${LEDGER}' rather than error" ;;
  *) fail "expected a scope refusal, got: ${REFUSAL}" ;;
esac
unset PT_API_URL PT_SANDBOX_KEY PT_WORKSPACE_ID PT_WORKSPACE_CWD
kill "$STUB_PID" 2>/dev/null || true


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
EXPECTED_PASSES=6
if [ "$PASS" -ne "$EXPECTED_PASSES" ]; then
  printf '  \033[31mINCOMPLETE\033[0m %s claims ran, expected %s\n' "$PASS" "$EXPECTED_PASSES"; exit 1
fi
echo "both platinum claims hold (${PASS} claims)."
