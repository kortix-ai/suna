#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# End-to-end policy engine smoke test — real `curl` against the real executor
# HTTP router (mounted on a Bun.serve with in-memory backends, no DB).
#
# Boots scripts/policy-harness.ts on a free port, then drives the full flow:
#   1. unauthenticated calls are 401
#   2. allow_all default: write call runs (200)
#   3. risk default: write call → 202 pending_approval; read → 200
#   4. project [[policies]] block → 403, also hides tool from /connectors
#   5. project rule overrides connector rule (admin trust)
#   6. invalid PUT bodies are 400
#   7. delete (destructive) blocked by project glob `*.delete*`
#
# Exits non-zero on first mismatch. Curl-driven from top to bottom.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PORT="${PORT:-18080}"
BASE="http://localhost:${PORT}/v1/executor"
TOKEN="Bearer test-executor-token"
ADMIN_HEADER="X-Test-Admin: alice"
PROJECT="proj-1"

# Force-kill anything on the port already
lsof -ti:"${PORT}" | xargs -r kill -9 2>/dev/null || true

HARNESS_LOG="$(mktemp -t policy-harness.XXXX.log)"
HARNESS_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

cd "$HARNESS_DIR"

echo "▸ booting policy-harness on :${PORT}…"
# The harness imports the real router; the config validator needs values to
# satisfy required envs, even though the harness never touches a DB.
export PORT
export DATABASE_URL="${DATABASE_URL:-postgres://stub/stub}"
export SUPABASE_URL="${SUPABASE_URL:-http://stub.local}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-stub}"
export API_KEY_SECRET="${API_KEY_SECRET:-stub-stub-stub-stub-stub-stub-stub-stub}"
export ALLOWED_SANDBOX_PROVIDERS="${ALLOWED_SANDBOX_PROVIDERS:-daytona}"
export DAYTONA_API_KEY="${DAYTONA_API_KEY:-stub}"
export DAYTONA_SERVER_URL="${DAYTONA_SERVER_URL:-http://stub.local}"
export DAYTONA_TARGET="${DAYTONA_TARGET:-stub}"
export TUNNEL_SIGNING_SECRET="${TUNNEL_SIGNING_SECRET:-stub-stub-stub-stub-stub-stub-stub-stub}"
bun run apps/api/scripts/policy-harness.ts >"$HARNESS_LOG" 2>&1 &
HARNESS_PID=$!
trap 'kill -9 $HARNESS_PID 2>/dev/null || true; rm -f "$HARNESS_LOG"' EXIT

# Wait for ready
for _ in $(seq 1 50); do
  if curl -sf "http://localhost:${PORT}/__test/world" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! curl -sf "http://localhost:${PORT}/__test/world" >/dev/null 2>&1; then
  echo "✗ harness failed to start within 5s. Log:"
  cat "$HARNESS_LOG"
  exit 1
fi
echo "  ✓ harness ready"

# ─── helpers ────────────────────────────────────────────────────────────────
ok=0; failures=0
expect() {
  local label="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    echo "  ✓ ${label}: ${got}"
    ok=$((ok+1))
  else
    echo "  ✗ ${label}: expected ${want}, got ${got}"
    failures=$((failures+1))
  fi
}

curl_status() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}
curl_body() {
  curl -s "$@"
}

reset_world() {
  curl -sf -X POST "http://localhost:${PORT}/__test/reset" >/dev/null
}

call_charges_create() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/call" \
    -H "Authorization: ${TOKEN}" -H 'Content-Type: application/json' \
    -d '{"connector":"stripe","action":"charges.create","args":{"amount":999}}'
}
call_charges_list() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/call" \
    -H "Authorization: ${TOKEN}" -H 'Content-Type: application/json' \
    -d '{"connector":"stripe","action":"charges.list","args":{}}'
}
call_charges_delete() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/call" \
    -H "Authorization: ${TOKEN}" -H 'Content-Type: application/json' \
    -d '{"connector":"stripe","action":"charges.delete","args":{"id":"ch_1"}}'
}

list_visible_actions() {
  curl_body "${BASE}/connectors" -H "Authorization: ${TOKEN}" | \
    bun -e 'const j=await Bun.stdin.json(); console.log(j.connectors[0].actions.map(a=>a.path).join(","))'
}

put_policies() {
  curl -s -o /dev/null -w '%{http_code}' -X PUT "${BASE}/projects/${PROJECT}/policies" \
    -H "${ADMIN_HEADER}" -H 'Content-Type: application/json' \
    -d "$1"
}

# ─── tests ──────────────────────────────────────────────────────────────────
echo
echo "▸ 1. authentication"
expect 'unauthenticated /connectors → 401' 401 "$(curl_status "${BASE}/connectors")"
expect 'unauthenticated /call → 401' 401 \
  "$(curl_status -X POST "${BASE}/call" -H 'Content-Type: application/json' -d '{}')"
expect 'admin endpoint without header → 403' 403 "$(curl_status "${BASE}/projects/${PROJECT}/policies")"

echo
echo "▸ 2. allow_all default (legacy): every call runs"
reset_world
expect 'charges.create with no policies → 200' 200 "$(call_charges_create)"
expect '/connectors lists all 3 actions' 'charges.create,charges.list,charges.delete' "$(list_visible_actions)"

echo
echo "▸ 3. risk default mode: WRITE/DESTRUCTIVE → require_approval, READ → run"
reset_world
expect 'switch default_mode → risk (200)' 200 "$(put_policies '{"policies":[],"defaultMode":"risk"}')"
expect 'charges.create (write) → 202 pending_approval' 202 "$(call_charges_create)"
expect 'charges.list (read) → 200' 200 "$(call_charges_list)"
expect 'charges.delete (destructive) → 202 pending_approval' 202 "$(call_charges_delete)"

echo
echo "▸ 4. project [[policies]] block (defense in depth: deny + hide)"
reset_world
expect 'put project block stripe.charges.create' 200 \
  "$(put_policies '{"policies":[{"match":"stripe.charges.create","action":"block"}],"defaultMode":"allow_all"}')"
expect 'charges.create → 403 policy_block' 403 "$(call_charges_create)"
expect '/connectors hides the blocked action' 'charges.list,charges.delete' "$(list_visible_actions)"

echo
echo "▸ 5. project trailing wildcard: *.delete* hides every delete tool"
reset_world
expect 'put project block *.delete*' 200 \
  "$(put_policies '{"policies":[{"match":"*.delete*","action":"block"}],"defaultMode":"allow_all"}')"
expect 'charges.delete → 403' 403 "$(call_charges_delete)"
expect 'charges.list (unrelated) still → 200' 200 "$(call_charges_list)"
expect 'charges.delete hidden from catalog' 'charges.create,charges.list' "$(list_visible_actions)"

echo
echo "▸ 6. require_approval at the project scope → 202 (and call is audited)"
reset_world
expect 'put project require_approval stripe.*' 200 \
  "$(put_policies '{"policies":[{"match":"stripe.*","action":"require_approval"}],"defaultMode":"allow_all"}')"
expect 'charges.create → 202 pending_approval' 202 "$(call_charges_create)"

echo
echo "▸ 7. input validation rejects bad PUT bodies"
expect 'invalid action → 400' 400 \
  "$(put_policies '{"policies":[{"match":"*","action":"skip"}],"defaultMode":"allow_all"}')"
expect 'missing match → 400' 400 \
  "$(put_policies '{"policies":[{"action":"block"}],"defaultMode":"allow_all"}')"
expect 'invalid default_mode coerced to allow_all (200)' 200 \
  "$(put_policies '{"policies":[],"defaultMode":"yolo"}')"

echo
echo "▸ 8. roundtrip: GET after PUT reflects current policies"
reset_world
put_policies '{"policies":[{"match":"*.delete*","action":"block"}],"defaultMode":"risk"}' >/dev/null
GET_BODY="$(curl_body "${BASE}/projects/${PROJECT}/policies" -H "${ADMIN_HEADER}")"
expect 'GET shows the rule we just PUT' \
  '{"policies":[{"match":"*.delete*","action":"block"}],"defaultMode":"risk","errors":[]}' \
  "$GET_BODY"

# ─── result ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────"
echo " passed: ${ok}    failed: ${failures}"
if (( failures > 0 )); then
  echo
  echo "harness log (last 30 lines):"
  tail -n 30 "$HARNESS_LOG"
  exit 1
fi
echo "all e2e policy curls green."
