#!/usr/bin/env bash
#
# CASE 6 (spec §6): feature-flag graceful degradation AT THE HTTP LAYER.
#
# Opt-in live test — brings up a real (throwaway) self-host data plane
# (Postgres + Supabase auth/rest/kong + the kortix-migrate one-shot + the
# API; no frontend/gateway/sandbox needed for this) and asserts the API
# degrades gracefully instead of 500ing when three optional integrations are
# deliberately left unconfigured:
#
#   - billing off               -> billing reads never 500 (account-state 200,
#                                   everything else a clean 404 + billing_disabled)
#   - managed-git absent         -> POST /v1/projects/provision returns a
#                                   graceful 503, not a crash
#
# NEVER runs by default: gated on RUN_SELFHOST_LIVE=1, and always allocates a
# brand-new, uniquely-named instance + a fresh block of loopback ports so it
# is safe to run next to any other self-host instance (dev box, CI matrix
# leg, another agent's live run) on the same machine.
#
# Requires: Docker + Docker Compose, `bun`, and the API image to exist
# locally (default kortix/kortix-api:selfhost-local — override via API_IMAGE).

set -Eeuo pipefail

if [ "${RUN_SELFHOST_LIVE:-}" != "1" ]; then
  echo "[graceful-degradation.live.sh] skipped: set RUN_SELFHOST_LIVE=1 to run this opt-in live test."
  exit 0
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)
CLI="bun run $REPO_ROOT/apps/cli/src/index.ts"

INSTANCE=${INSTANCE:-selfhost-e2e-degrade-$(date +%s)-$RANDOM}
API_IMAGE=${API_IMAGE:-kortix/kortix-api:selfhost-local}
EMAIL=${EMAIL:-owner-$INSTANCE@kortix.local}
PASSWORD=${PASSWORD:-kortix-e2e-password}
CONFIG_DIR="$HOME/.config/kortix/self-host/$INSTANCE"
CLI_CONFIG_FILE="$SCRIPT_DIR/.work-$INSTANCE-cli-config.json"
KEEP_ON_FAIL=${KEEP_ON_FAIL:-false}

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
section() { printf "\n${BOLD}== %s ==${RESET}\n" "$1"; }
ok() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
note() { printf "  ${DIM}%s${RESET}\n" "$1"; }
die() { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

export KORTIX_CONFIG_FILE="$CLI_CONFIG_FILE"

compose() { docker compose --project-name "kortix-$INSTANCE" --env-file "$CONFIG_DIR/.env" -f "$CONFIG_DIR/docker-compose.yml" "$@"; }
container_id() { compose ps -aq "$1"; }

wait_healthy() {
  local service=$1 timeout=${2:-120} start id state
  start=$(date +%s)
  while true; do
    id=$(container_id "$service")
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
    [ "$state" = "healthy" ] && return 0
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      compose logs "$service" 2>&1 | tail -80 >&2
      die "$service never became healthy (state=${state:-missing})"
    fi
    sleep 2
  done
}

wait_completed() {
  local service=$1 timeout=${2:-180} start id state
  start=$(date +%s)
  while true; do
    id=$(container_id "$service")
    state=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || true)
    [ "$state" = "exited" ] && return 0
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      compose logs "$service" 2>&1 | tail -80 >&2
      die "$service did not complete (state=${state:-missing})"
    fi
    sleep 2
  done
}

json_get() {
  python3 -c 'import json,sys
data=json.load(sys.stdin)
cur=data
for part in sys.argv[1].split("."):
    if part == "":
        continue
    cur = cur[int(part)] if isinstance(cur, list) else cur[part]
print(cur)' "$1"
}

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" -ne 0 ] && [ "$KEEP_ON_FAIL" = "true" ]; then
    note "Keeping failed stack for inspection: $INSTANCE"
    note "Inspect with: kortix self-host logs --instance $INSTANCE"
    return "$rc"
  fi
  compose down --remove-orphans --volumes >/dev/null 2>&1
  rm -f "$CLI_CONFIG_FILE"
}
trap cleanup EXIT

section "Allocate Isolated Ports"
read -r API_PORT SUPABASE_PORT POSTGRES_PORT FRONTEND_PORT <<<"$(python3 - <<'PY'
import socket
ports = []
for _ in range(4):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    ports.append(s.getsockname()[1])
print(" ".join(map(str, ports)))
PY
)"
ok "instance $INSTANCE (api port $API_PORT)"

section "CLI Self-host Setup (billing off, managed-git unconfigured)"
$CLI self-host init --instance "$INSTANCE" >/dev/null
$CLI self-host env set --instance "$INSTANCE" \
  "API_PUBLIC_URL=http://localhost:$API_PORT" \
  "SUPABASE_PUBLIC_URL=http://localhost:$SUPABASE_PORT" \
  "API_PORT=$API_PORT" "SUPABASE_PORT=$SUPABASE_PORT" "POSTGRES_PORT=$POSTGRES_PORT" \
  "FRONTEND_PORT=$FRONTEND_PORT" \
  "ALLOWED_SANDBOX_PROVIDERS=daytona" \
  "DAYTONA_API_KEY=degrade-check-dummy" \
  "DAYTONA_SERVER_URL=https://daytona.invalid" \
  "DAYTONA_TARGET=degrade-check" \
  "OPENROUTER_API_KEY=degrade-check-dummy" \
  "KORTIX_LOCAL_IMAGES=true" \
  "API_IMAGE=$API_IMAGE" >/dev/null
# Deliberately leave every MANAGED_GIT_* / KORTIX_GITHUB_APP_* key unset —
# that's the exact condition case 6 tests against.
ok "config initialized: billing off (default), managed-git unset"

section "Bring Up Data Plane (db, auth, rest, kong, migrate, api)"
compose up -d --no-deps supabase-db
wait_healthy supabase-db 120
compose up -d --no-deps supabase-auth supabase-rest
wait_healthy supabase-auth 120
wait_healthy supabase-rest 120
compose up -d --no-deps kortix-migrate
wait_completed kortix-migrate 180
compose up -d --no-deps supabase-kong
wait_healthy supabase-kong 120
compose up -d --no-deps kortix-api
ok "compose up"

section "API Health"
START=$(date +%s)
until curl -fsS "http://localhost:$API_PORT/v1/health" >/dev/null 2>&1; do
  [ $(( $(date +%s) - START )) -ge 120 ] && { compose logs kortix-api 2>&1 | tail -30 >&2; die "API never became healthy"; }
  sleep 2
done
ok "API healthy"

section "Bootstrap Owner + Auth"
BODY=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")
BO=$(curl -fsS -X POST "http://localhost:$API_PORT/v1/setup/bootstrap-owner" -H 'content-type: application/json' -d "$BODY")
printf '%s' "$BO" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' || die "bootstrap-owner failed: $BO"
ok "owner bootstrapped"

source "$CONFIG_DIR/.env"
TOK=$(curl -fsS -X POST "http://localhost:$SUPABASE_PORT/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H 'content-type: application/json' -d "$BODY")
ACCESS=$(printf '%s' "$TOK" | json_get access_token)
[ -n "$ACCESS" ] || die "token exchange failed"
ok "authenticated"

AUTH_HEADER="authorization: Bearer $ACCESS"
API="http://localhost:$API_PORT"

section "Managed-git absent: pre-check + provision degrade gracefully (no 500)"
STATUS_JSON=$(curl -fsS -H "$AUTH_HEADER" "$API/v1/projects/managed-git/status")
[ "$(printf '%s' "$STATUS_JSON" | json_get configured)" = "False" ] || die "expected managed-git/status.configured=false, got: $STATUS_JSON"
ok "GET /v1/projects/managed-git/status -> 200 {configured: false}"

PROVISION_CODE=$(curl -s -o /tmp_provision_body.$$ -w '%{http_code}' -X POST "$API/v1/projects/provision" \
  -H "$AUTH_HEADER" -H 'content-type: application/json' -d '{}')
PROVISION_BODY=$(cat /tmp_provision_body.$$ 2>/dev/null || true)
rm -f /tmp_provision_body.$$
[ "$PROVISION_CODE" = "503" ] || die "expected 503 from POST /v1/projects/provision with managed-git unconfigured, got $PROVISION_CODE: $PROVISION_BODY"
printf '%s' "$PROVISION_BODY" | grep -qi "not configured" || die "503 body doesn't explain why: $PROVISION_BODY"
ok "POST /v1/projects/provision -> 503 graceful body (not a 500)"

section "Billing off: account-state stays 200, everything else 404 + billing_disabled (no 500)"
ACCOUNT_STATE_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH_HEADER" "$API/v1/billing/account-state")
[ "$ACCOUNT_STATE_CODE" = "200" ] || die "expected 200 from GET /v1/billing/account-state with billing off, got $ACCOUNT_STATE_CODE"
ok "GET /v1/billing/account-state -> 200 (local/unlimited mock)"

GATED_CODE=$(curl -s -o /tmp_gated_body.$$ -w '%{http_code}' -H "$AUTH_HEADER" "$API/v1/billing/credit-breakdown")
GATED_BODY=$(cat /tmp_gated_body.$$ 2>/dev/null || true)
rm -f /tmp_gated_body.$$
[ "$GATED_CODE" = "404" ] || die "expected 404 (not 500) from a billing-gated read with billing off, got $GATED_CODE: $GATED_BODY"
printf '%s' "$GATED_BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("billing_disabled") is True else 1)' \
  || die "expected billing_disabled:true in gated response: $GATED_BODY"
ok "GET /v1/billing/credit-breakdown -> 404 {billing_disabled: true} (not a 500)"

section "Result"
ok "Both flag-off/unconfigured paths degrade gracefully — no 500s"
