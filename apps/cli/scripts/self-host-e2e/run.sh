#!/usr/bin/env bash
#
# Full self-host control-plane e2e for the Kortix CLI.
#
# This uses only the public CLI, Docker Compose, curl, and psql inside the
# self-hosted Postgres container. It verifies setup, auth, API access, schema
# migration, update, and persisted data. Agent sessions require a configured
# external sandbox provider and are intentionally outside this hermetic lane.

set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
CLI="bun run $CLI_ROOT/src/index.ts"

INSTANCE=${INSTANCE:-selfhost-e2e-$(date +%s)}
TAG=${TAG:-latest}
KORTIX_LOCAL_IMAGES=${KORTIX_LOCAL_IMAGES:-false}
KEEP_ON_FAIL=${KEEP_ON_FAIL:-false}
KEEP_ON_SUCCESS=${KEEP_ON_SUCCESS:-false}
EMAIL=${EMAIL:-owner-$INSTANCE@kortix.local}
PASSWORD=${PASSWORD:-kortix-e2e-password}
CONFIG_DIR="$HOME/.config/kortix/self-host/$INSTANCE"
WORK_DIR="$SCRIPT_DIR/work/$INSTANCE"
CLI_CONFIG_FILE="$WORK_DIR/config.json"

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

section() { printf "\n${BOLD}== %s ==${RESET}\n" "$1"; }
ok() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
note() { printf "  ${DIM}%s${RESET}\n" "$1"; }
die() { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

json_get() {
  python3 -c 'import json,sys; data=json.load(sys.stdin); cur=data
for part in sys.argv[1].split("."):
    if part == "":
        continue
    if isinstance(cur, list):
        cur = cur[int(part)]
    else:
        cur = cur[part]
print(cur)' "$1"
}

free_ports() {
  python3 - "$1" <<'PY'
import socket, sys
n = int(sys.argv[1])
socks = []
ports = []
for _ in range(n):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    ports.append(sock.getsockname()[1])
    socks.append(sock)
print(" ".join(map(str, ports)))
PY
}

wait_for_json() {
  local name=$1
  local url=$2
  local timeout=${3:-120}
  local start
  start=$(date +%s)
  until curl -fsS "$url" >/dev/null 2>&1; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      die "$name did not become ready: $url"
    fi
    sleep 2
  done
  ok "$name ready"
}

wait_for_db_table() {
  local name=$1
  local table=$2
  local timeout=${3:-120}
  local start
  start=$(date +%s)
  until psql_selfhost -tAc "select to_regclass('$table') is not null" 2>/dev/null | grep -q '^t$'; do
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      die "$name did not become ready: $table"
    fi
    sleep 2
  done
  ok "$name ready"
}

compose() {
  docker compose \
    --project-name "kortix-$INSTANCE" \
    --env-file "$CONFIG_DIR/.env" \
    -f "$CONFIG_DIR/docker-compose.yml" \
    "$@"
}

psql_selfhost() {
  compose exec -T supabase-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" -eq 0 ] && [ "$KEEP_ON_SUCCESS" = "true" ]; then
    note "Keeping successful stack for follow-up checks: $INSTANCE"
    return 0
  fi
  if [ "$rc" -ne 0 ] && [ "$KEEP_ON_FAIL" = "true" ]; then
    note "Keeping failed stack for inspection: $INSTANCE"
    return "$rc"
  fi
  compose down --remove-orphans --volumes >/dev/null 2>&1
  rm -rf "$WORK_DIR"
  if [ "$rc" -ne 0 ]; then
    note "Logs: kortix self-host logs --instance $INSTANCE"
  fi
}
trap cleanup EXIT

section "Allocate Isolated Ports"
read -r FRONTEND_PORT API_PORT SUPABASE_PORT POSTGRES_PORT <<<"$(free_ports 4)"
PUBLIC_URL="http://localhost:$FRONTEND_PORT"
API_PUBLIC_URL="http://localhost:$API_PORT"
SUPABASE_PUBLIC_URL="http://localhost:$SUPABASE_PORT"
mkdir -p "$WORK_DIR"
export KORTIX_CONFIG_FILE="$CLI_CONFIG_FILE"
ok "Work folder: $WORK_DIR"
note "Instance: $INSTANCE"

section "CLI Self-host Setup"
INIT_ARGS=(self-host init --instance "$INSTANCE" --tag "$TAG")
if [ "$KORTIX_LOCAL_IMAGES" = "true" ]; then
  INIT_ARGS+=(--local-images)
fi
$CLI "${INIT_ARGS[@]}" >/tmp/kortix-selfhost-init-$INSTANCE.log
$CLI self-host env set --instance "$INSTANCE" \
  "PUBLIC_URL=$PUBLIC_URL" \
  "API_PUBLIC_URL=$API_PUBLIC_URL" \
  "SUPABASE_PUBLIC_URL=$SUPABASE_PUBLIC_URL" \
  "FRONTEND_PORT=$FRONTEND_PORT" \
  "API_PORT=$API_PORT" \
  "SUPABASE_PORT=$SUPABASE_PORT" \
  "POSTGRES_PORT=$POSTGRES_PORT" \
  "ALLOWED_SANDBOX_PROVIDERS=daytona" \
  "DAYTONA_API_KEY=self-host-control-plane-e2e" >/dev/null
ok "Config initialized without prompts"

section "Start Stack"
$CLI self-host start --instance "$INSTANCE" --tag "$TAG"
ok "Docker Compose started"

section "Schema Bootstrap"
MIGRATE_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "kortix-$INSTANCE-kortix-migrate-1" 2>/dev/null || echo "missing")
[ "$MIGRATE_EXIT" = "0" ] || die "kortix-migrate failed (exit=$MIGRATE_EXIT)"
ok "kortix-migrate completed (exit 0)"

section "HTTP Health"
wait_for_json "API" "$API_PUBLIC_URL/v1/health" 180
wait_for_json "frontend runtime config" "$PUBLIC_URL/api/runtime-config" 180
wait_for_db_table "Kortix schema" "kortix.project_snapshot_builds" 180
wait_for_db_table "Kortix accounts" "kortix.account_members" 60

source "$CONFIG_DIR/.env"
curl --connect-timeout 5 --max-time 30 -fsS \
  -H "apikey: $SUPABASE_ANON_KEY" \
  "$SUPABASE_PUBLIC_URL/auth/v1/health" >/dev/null
ok "Supabase auth healthy"

section "Bootstrap Owner"
BOOTSTRAP_BODY=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")
BOOTSTRAP_JSON=$(curl -fsS -X POST "$API_PUBLIC_URL/v1/setup/bootstrap-owner" \
  -H 'content-type: application/json' \
  -d "$BOOTSTRAP_BODY")
[ "$(printf '%s' "$BOOTSTRAP_JSON" | json_get success)" = "True" ] || die "bootstrap owner failed: $BOOTSTRAP_JSON"
ok "Owner bootstrapped: $EMAIL"

TOKEN_JSON=$(curl -fsS -X POST "$SUPABASE_PUBLIC_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H 'content-type: application/json' \
  -d "$BOOTSTRAP_BODY")
ACCESS_TOKEN=$(printf '%s' "$TOKEN_JSON" | json_get access_token)
[ -n "$ACCESS_TOKEN" ] || die "token exchange failed"
ok "Supabase password token exchange works"

section "Authenticated API"
ACCOUNTS_JSON=$(curl -fsS -H "authorization: Bearer $ACCESS_TOKEN" "$API_PUBLIC_URL/v1/accounts")
ACCOUNT_ID=$(printf '%s' "$ACCOUNTS_JSON" | json_get 0.account_id)
[ -n "$ACCOUNT_ID" ] || die "could not resolve account id"
ok "GET /v1/accounts works: $ACCOUNT_ID"

PROJECTS_JSON=$(curl -fsS -H "authorization: Bearer $ACCESS_TOKEN" "$API_PUBLIC_URL/v1/projects")
printf '%s' "$PROJECTS_JSON" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null
ok "GET /v1/projects works"

section "Update Mechanism"
$CLI self-host update --instance "$INSTANCE" --tag "$TAG"
ok "self-host update completed"

MIGRATE_EXIT2=$(docker inspect -f '{{.State.ExitCode}}' "kortix-$INSTANCE-kortix-migrate-1" 2>/dev/null || echo "missing")
[ "$MIGRATE_EXIT2" = "0" ] || die "post-update kortix-migrate failed (exit=$MIGRATE_EXIT2)"
wait_for_json "API (post-update)" "$API_PUBLIC_URL/v1/health" 180
wait_for_db_table "Kortix schema (post-update)" "kortix.project_snapshot_builds" 60
ok "stack healthy after update; migrations idempotent"

REBOOTSTRAP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_PUBLIC_URL/v1/setup/bootstrap-owner" \
  -H 'content-type: application/json' -d "$BOOTSTRAP_BODY")
[ "$REBOOTSTRAP" = "409" ] || die "expected owner-exists 409 after update, got $REBOOTSTRAP"
ok "data persisted across update (owner still present -> 409)"

section "CLI Host Registration"
$CLI hosts info selfhost >/dev/null
ok "CLI registered selfhost host"

section "Result"
ok "Full self-host control-plane e2e passed"
note "Agent-session coverage requires a configured external sandbox provider."
