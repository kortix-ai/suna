#!/usr/bin/env bash
# THE WORKER IN A REAL CELL ON PLATINUM DEV — folder-scoped.
#
# Everything the local suites prove with a celld in Docker, done against the
# platform: the pt-celld template, a `runtime: cell` sandbox created WITH a
# worker name, the bundle deployed to that worker's folder, and the cell's own
# writes landing under workers/<name>/ in the org prefix. Measured by hand on
# 2026-09-04 before this existed: without a worker every cell in an org shared
# one deploy/current.json at the org root.
#
# Reaching the cell over HTTP is NOT claimed here: dev's control plane has no
# Caddy vhost for *.sbx-dev.platinum.dev (infra/celld/test/harness-durable-object.sh
# in Platinum has the measurement), cells refuse exec by design, and sandboxes
# have no route to each other. What IS claimed is everything up to that edge.
#
# Needs: a Platinum dev token (as dev-e2e.sh), and the dev bucket's S3
# credentials in PT_S3_ENDPOINT / PT_S3_BUCKET / PT_S3_REGION /
# PT_S3_ACCESS_KEY / PT_S3_SECRET_KEY (Platinum: dotenvx get … -f apps/api/.env.dev).
# SKIPs by name without them. The cell runtime must be enabled on dev.
set -u
cd "$(dirname "$0")/.."
API=${PT_API_URL:-https://api-dev.platinum.dev}
TOK=${PT_SANDBOX_KEY:-$(grep -E '^default[[:space:]]*=' ~/.config/platinum/credentials 2>/dev/null | sed -E 's/^default[[:space:]]*=[[:space:]]*"?//; s/"?[[:space:]]*$//')}
[ -n "$TOK" ] || { echo "  SKIP: no Platinum dev token"; exit 0; }
for v in PT_S3_ENDPOINT PT_S3_BUCKET PT_S3_ACCESS_KEY PT_S3_SECRET_KEY; do [ -n "${!v:-}" ] || { echo "  SKIP: $v not set — the dev bucket's credentials are needed to deploy and to read the layout back"; exit 0; }; done
REGION=${PT_S3_REGION:-us-east-1}; case "$PT_S3_ENDPOINT" in http*) EP="$PT_S3_ENDPOINT";; *) EP="https://$PT_S3_ENDPOINT";; esac
WORKER=${CELL_WORKER:-pi-agent}
H=(-H "Authorization: Bearer $TOK" -H "content-type: application/json")
PASS=0; FAIL=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
api() { curl -sS -m "${2:-60}" "${H[@]}" "$@"; }
mc() { docker run --rm --entrypoint sh quay.io/minio/mc -c "mc alias set d $EP $PT_S3_ACCESS_KEY $PT_S3_SECRET_KEY >/dev/null 2>&1; $1" 2>/dev/null; }

echo "== 1. the gate and the template =="
G=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/sandboxes" "${H[@]}" -d '{"template":"pt-celld","runtime":"cell","name":"gate-probe","ram_mb":4096,"cpu":2}')
[ "$G" != "501" ] && pass "the cell runtime is enabled on dev (create is not 501)" || { fail "runtime 'cell' is gated off on dev (501)"; exit 1; }
TPL=$(api "$API/v1/templates" | python3 -c 'import json,sys; d=json.load(sys.stdin); l=d if isinstance(d,list) else d.get("templates",d.get("items",[])); print(next((t["id"] for t in l if t.get("name")=="pt-celld" and t.get("state","ready")=="ready"),""))')
if [ -z "$TPL" ]; then
  TPL=$(python3 -c 'import json; s=json.load(open("../pt-celld.spec.json")); s.setdefault("name","pt-celld"); print(json.dumps(s))' | api -X POST "$API/v1/templates/from-spec" -d @- | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
  for _ in $(seq 1 120); do S=$(api "$API/v1/templates/$TPL" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))'); [ "$S" = "ready" ] && break; [ "$S" = "failed" ] && break; sleep 5; done
fi
[ -n "$TPL" ] && pass "pt-celld template on dev: $TPL" || { fail "no pt-celld template and the build did not return one"; exit 1; }

echo "== 2. a workspace, and a cell that names its worker =="
WS=$(api -X POST "$API/v1/sandboxes?wait_for_state=running" -d '{"template":"pt-base","cpu":1,"ram_mb":512,"name":"cell-dev-workspace"}' | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))')
[ -n "$WS" ] && pass "workspace sandbox: $WS" || { fail "workspace create failed"; exit 1; }
CELL=""
cleanup() {
  for s in $CELL $WS; do [ -n "$s" ] && printf '  cleanup: %s → %s\n' "$s" "$(curl -s -m 60 -o /dev/null -w '%{http_code}' -X DELETE "$API/v1/sandboxes/$s" "${H[@]}")"; done
}
trap cleanup EXIT
BODY=$(python3 - "$API" "$TOK" "$WS" "$WORKER" <<'PY'
import json,sys
api,tok,ws,w=sys.argv[1:5]
print(json.dumps({"template":"pt-celld","runtime":"cell","worker":w,"name":"cell-dev-e2e","ram_mb":4096,"cpu":2,"exposed_ports":[8080],
  "env":{"CELLD_VAR_PT_API_URL":api,"CELLD_VAR_PT_SANDBOX_KEY":tok,"CELLD_VAR_PT_WORKSPACE_ID":ws,"CELLD_VAR_PT_WORKSPACE_CWD":"/root","CELLD_VAR_PT_AGENT_SCRIPTED":"1","CELLD_VAR_TOOL_DAEMON_TOKEN":"unused"}}))
PY
)
R=$(api -X POST "$API/v1/sandboxes?wait_for_state=running&wait_timeout_ms=240000" 300 -d "$BODY"); CELL=$(echo "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
[ -n "$CELL" ] && pass "cell created with worker=$WORKER: $CELL" || { fail "cell create: ${R:0:200}"; exit 1; }
ROW=$(api "$API/v1/sandboxes/$CELL"); ORG=$(echo "$ROW" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("orgId",""))'); RW=$(echo "$ROW" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("worker"))')
[ "$RW" = "$WORKER" ] && pass "the sandbox row carries worker=$WORKER" || fail "the row's worker is '$RW'"
[ "$(api "$API/v1/sandboxes?worker=$WORKER" | python3 -c 'import json,sys; d=json.load(sys.stdin); l=d if isinstance(d,list) else d.get("sandboxes",d.get("items",[])); print(",".join(sorted(s["id"] for s in l)))')" = "$CELL" ] \
  && pass "?worker=$WORKER lists exactly this cell" || fail "?worker= filter did not return exactly the cell"

echo "== 3. the cell's own writes land in ITS folder =="
sleep 8
L=$(mc "mc ls --recursive d/$PT_S3_BUCKET/orgs/$ORG/workers/$WORKER/" | grep -c fleet/)
[ "$L" -ge 1 ] && pass "celld wrote under orgs/$ORG/workers/$WORKER/ (fleet/ present) — the folder, not the org root" || fail "nothing under workers/$WORKER/: $(mc "mc ls --recursive d/$PT_S3_BUCKET/orgs/$ORG/" | head -3 | tr '\n' ' ')"

echo "== 4. the bundle, deployed to the worker's folder, and adopted after a restart =="
npm run --silent build >/dev/null 2>&1 || { fail "build"; exit 1; }
D=$(docker run --rm --platform linux/amd64 -v "$PWD:/app" -w /app -e AWS_ACCESS_KEY_ID="$PT_S3_ACCESS_KEY" -e AWS_SECRET_ACCESS_KEY="$PT_S3_SECRET_KEY" -e AWS_REGION="$REGION" pt-celld:0.3.0 celld deploy . --bucket "s3://$PT_S3_BUCKET/orgs/$ORG/workers/$WORKER" --endpoint "$EP" --region "$REGION" 2>&1 | grep -oE "Current Version ID: [0-9a-f]+" | cut -d' ' -f4)
[ -n "$D" ] && pass "celld deploy wrote version $D to workers/$WORKER/deploy/" || { fail "celld deploy failed"; exit 1; }
api -X POST "$API/v1/sandboxes/$CELL/stop" >/dev/null; sleep 3; api -X POST "$API/v1/sandboxes/$CELL/start?wait_for_state=running" 120 >/dev/null; sleep 8
P=$(mc "mc cat d/$PT_S3_BUCKET/orgs/$ORG/workers/$WORKER/deploy/current.json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))')
[ "$P" = "$D" ] && pass "the worker folder's deploy/current.json points at $D — the version this cell boots" || fail "pointer is '$P', deployed $D"
trap - EXIT; cleanup
EXPECTED_PASSES=8
if [ "$FAIL" -eq 0 ] && [ "$PASS" -ne "$EXPECTED_PASSES" ]; then printf '  \033[31mINCOMPLETE\033[0m %s claims ran, expected %s\n' "$PASS" "$EXPECTED_PASSES"; exit 1; fi
printf '\n  the worker in a real cell on dev: %s passed, %s failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]
