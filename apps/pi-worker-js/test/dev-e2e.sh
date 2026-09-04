#!/usr/bin/env bash
# THE HARNESS IN A CELL, THE WORK IN A PLATINUM DEV SANDBOX.
#
# Boots this worker on a LOCAL celld node (celldctl up, scripted model — no LLM
# key), creates a real sandbox on Platinum DEV as the workspace, points the
# cell at it with PT_API_URL / PT_SANDBOX_KEY / PT_WORKSPACE_ID, and drives one
# scripted turn whose `bash` must execute inside that sandbox. The proof is read
# back through Platinum's own files API — not through the cell — and the
# sandbox is deleted afterwards. Dev is left as found.
#
# Measured 2026-09-04 against api-dev: 6 claims, 0 failed. Two things it
# established that were not obvious:
#   · pt-base runs as root with HOME=/ and has no /home/user, so the workspace
#     cwd must be /root (PT_WORKSPACE_CWD). The worker's fallback of /home/user
#     matches Kortix images, not pt-base.
#   · a relative `read` of a missing file makes the cell print the absolute
#     path it resolved — the cheapest way to see the cwd a cell really holds.
#
# Needs: docker + the local celld image, MinIO on 19000 (see agent.config.json
# targets.local), and a Platinum dev token: PT_SANDBOX_KEY in the environment,
# or ~/.config/platinum/credentials (`default = <token>`).
set -u
cd "$(dirname "$0")/.."
API=${PT_API_URL:-https://api-dev.platinum.dev}
TOK=${PT_SANDBOX_KEY:-$(grep -E '^default[[:space:]]*=' ~/.config/platinum/credentials 2>/dev/null | sed -E 's/^default[[:space:]]*=[[:space:]]*"?//; s/"?[[:space:]]*$//')}
[ -n "$TOK" ] || { echo "  SKIP: no Platinum dev token (PT_SANDBOX_KEY or ~/.config/platinum/credentials)"; exit 0; }
CWD=${PT_WORKSPACE_CWD:-/root}
H=(-H "Authorization: Bearer $TOK" -H "content-type: application/json")
PASS=0; FAIL=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
cell() { curl -s -m 120 "http://127.0.0.1:18080$1" "${@:2}"; }
tool_text() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(" ".join(str(c.get("text","")) for m in d["messages"] if m["role"]=="toolResult" for c in (m["message"].get("content") or [])))' 2>/dev/null; }

echo "== 1. a workspace on Platinum dev =="
R=$(curl -sS -m 90 -X POST "$API/v1/sandboxes?wait_for_state=running" "${H[@]}" -d '{"template":"pt-base","cpu":1,"ram_mb":512,"name":"pi-worker-js-dev-e2e"}')
SBX=$(echo "$R" | grep -oE '"id":"sbx_[A-Za-z0-9_-]+"' | head -1 | cut -d'"' -f4)
[ -n "$SBX" ] && pass "dev sandbox created: $SBX" || { fail "dev sandbox create: ${R:0:160}"; exit 1; }
cleanup() {
  node celldctl.mjs down >/dev/null 2>&1
  D=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X DELETE "$API/v1/sandboxes/$SBX" "${H[@]}")
  case "$D" in 2*) pass "dev sandbox deleted ($D) — dev left as found";; *) fail "delete returned $D — CLEAN UP $SBX BY HAND";; esac
}
trap cleanup EXIT

echo "== 2. the cell, pointed at it =="
export PT_API_URL=$API PT_SANDBOX_KEY=$TOK PT_WORKSPACE_ID=$SBX PT_WORKSPACE_CWD=$CWD PT_AGENT_SCRIPTED=1
node celldctl.mjs down >/dev/null 2>&1
node celldctl.mjs up >/dev/null 2>&1 && pass "cell node up on a local celld, PT_* -> $SBX" || fail "celldctl up failed: $(node celldctl.mjs up 2>&1 | tail -2 | tr '\n' ' ')"
SES="dev-$RANDOM"
for _ in $(seq 1 60); do [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:18080/health?c=$SES")" = "200" ] && break; sleep 0.5; done

echo "== 3. the cwd the cell really holds =="
cell "/prompt?c=probe-$SES" -X POST -H 'content-type: application/json' -d '{"text":"probe","script":[{"tool":"read","id":"p1","args":{"path":"does-not-exist.txt"}},{"text":"probed"}]}' >/dev/null
RES=$(cell "/history?c=probe-$SES" | tool_text | grep -oE "/[A-Za-z0-9_./-]*does-not-exist.txt" | head -1)
[ "$RES" = "$CWD/does-not-exist.txt" ] && pass "the cell resolves paths under $CWD, as asked" || fail "the cell resolved ${RES:-nothing}, asked for $CWD"

echo "== 4. one turn: bash in the cell, executed in the dev sandbox =="
MARK="pi-worker-js-$RANDOM"
cell "/prompt?c=$SES" -X POST -H 'content-type: application/json' -d "{\"text\":\"leave a marker\",\"script\":[{\"tool\":\"bash\",\"id\":\"b1\",\"args\":{\"command\":\"echo $MARK > $CWD/pi-worker-js.txt && pwd && id -un\"}},{\"text\":\"done\"}]}" >/dev/null
HIST=$(cell "/history?c=$SES")
ROLES=$(echo "$HIST" | python3 -c 'import json,sys; print(",".join(m["role"] for m in json.load(sys.stdin)["messages"]))' 2>/dev/null)
[ "$ROLES" = "user,assistant,toolResult,assistant" ] && pass "the turn ran: $ROLES" || fail "transcript: ${ROLES:-none}"
TR=$(echo "$HIST" | tool_text)
echo "$TR" | grep -qE "^$CWD" && ! echo "$TR" | grep -qiE "error|denied|can.t|No such|\[exit [1-9]" \
  && pass "bash ran in the sandbox as $(echo "$TR" | sed -n 2p | tr -d '\n') in $CWD" || fail "tool result: ${TR:0:160}"

echo "== 5. THE POINT: the file is in the dev sandbox, read via Platinum, not via the cell =="
F=$(curl -s -m 30 "$API/v1/sandboxes/$SBX/files?path=$CWD/pi-worker-js.txt" "${H[@]}")
echo "$F" | grep -q "$MARK" && pass "the work landed in $SBX: marker read back through /v1/sandboxes/:id/files" || fail "marker not in the dev sandbox: ${F:0:160}"

# Teardown BEFORE the summary, so the count includes the delete and a failed
# delete is in the tally rather than after it.
trap - EXIT; cleanup
EXPECTED_PASSES=7
echo
[ "$FAIL" -eq 0 ] && echo "  the harness lives in a cell and the work lands on Platinum dev: ${PASS} claims" || echo "  ${FAIL} of $((PASS+FAIL)) claims failed"
exit "$FAIL"
