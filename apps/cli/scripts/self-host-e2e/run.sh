#!/usr/bin/env bash
#
# Full self-host e2e for the Kortix CLI.
#
# This intentionally uses only the public CLI, Docker Compose, curl, and psql
# inside the self-hosted Postgres container. It does not depend on a dev API.

set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
SUNA_ROOT=$(cd "$CLI_ROOT/../.." && pwd)
CLI="bun run $CLI_ROOT/src/index.ts"

INSTANCE=${INSTANCE:-selfhost-e2e-$(date +%s)}
TAG=${TAG:-latest}
FRONTEND_IMAGE=${FRONTEND_IMAGE:-}
API_IMAGE=${API_IMAGE:-}
SANDBOX_IMAGE=${SANDBOX_IMAGE:-}
KORTIX_LOCAL_IMAGES=${KORTIX_LOCAL_IMAGES:-false}
KEEP_ON_FAIL=${KEEP_ON_FAIL:-false}
EMAIL=${EMAIL:-owner-$INSTANCE@kortix.local}
PASSWORD=${PASSWORD:-kortix-e2e-password}
CONFIG_DIR="$HOME/.config/kortix/self-host/$INSTANCE"
WORK_DIR="$SCRIPT_DIR/work/$INSTANCE"
CLI_CONFIG_FILE="$WORK_DIR/config.json"
PROJECT_NAME="self-host-e2e-$INSTANCE"
PROJECT_REPO_URL="https://example.com/$PROJECT_NAME.git"
PROJECT_COMMIT="0000000000000000000000000000000000000000"

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
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    ports.append(s.getsockname()[1])
    socks.append(s)
print(" ".join(map(str, ports)))
PY
}

free_port_block() {
  python3 <<'PY'
import socket
for base in range(18000, 26000, 16):
    socks = []
    ok = True
    try:
        for port in range(base, base + 8):
            s = socket.socket()
            s.bind(("127.0.0.1", port))
            socks.append(s)
    except OSError:
        ok = False
    for s in socks:
        s.close()
    if ok:
        print(base)
        raise SystemExit(0)
raise SystemExit("no free 8-port sandbox block found")
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

wait_for_sandbox_health() {
  local url=$1
  local timeout=${2:-240}
  local start
  start=$(date +%s)
  while true; do
    local body
    body=$(curl -fsS "$url" 2>/dev/null || true)
    if [ -n "$body" ] && printf '%s' "$body" | python3 -c 'import json, sys
body = json.load(sys.stdin)
status = body.get("status")
runtime_ready = body.get("runtimeReady") is True
if status in ("ok", "degraded") and runtime_ready:
    raise SystemExit(0)
raise SystemExit(1)' >/dev/null 2>&1; then
      ok "sandbox container health ready"
      return 0
    fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      [ -n "$body" ] && printf '%s\n' "$body" >&2
      die "sandbox container health did not become runtime-ready: $url"
    fi
    sleep 2
  done
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
  if [ "$rc" -ne 0 ] && [ "$KEEP_ON_FAIL" = "true" ]; then
    note "Keeping failed stack for inspection: $INSTANCE"
    note "Inspect with: kortix self-host logs --instance $INSTANCE"
    return "$rc"
  fi
  if [ -n "${PROJECT_ID:-}" ]; then
    psql_selfhost -c "delete from kortix.projects where project_id = '$PROJECT_ID'::uuid;" >/dev/null 2>&1
  fi
  docker rm -f "kortix-$INSTANCE-sandbox" >/dev/null 2>&1
  compose down --remove-orphans --volumes >/dev/null 2>&1
  rm -rf "$WORK_DIR"
  if [ "$rc" -ne 0 ]; then
    note "Logs: kortix self-host logs --instance $INSTANCE"
  fi
}
trap cleanup EXIT

section "Allocate Isolated Ports"
read -r FRONTEND_PORT API_PORT SUPABASE_PORT POSTGRES_PORT <<<"$(free_ports 4)"
SANDBOX_PORT_BASE=$(free_port_block)
PUBLIC_URL="http://localhost:$FRONTEND_PORT"
API_PUBLIC_URL="http://localhost:$API_PORT"
SUPABASE_PUBLIC_URL="http://localhost:$SUPABASE_PORT"
SANDBOX_HEALTH_URL="http://localhost:$SANDBOX_PORT_BASE/kortix/health"
mkdir -p "$WORK_DIR"
export KORTIX_CONFIG_FILE="$CLI_CONFIG_FILE"
ok "Work folder: $WORK_DIR"
note "Instance: $INSTANCE"
note "Dashboard: $PUBLIC_URL"
note "API: $API_PUBLIC_URL"
note "Supabase: $SUPABASE_PUBLIC_URL"
note "Sandbox port base: $SANDBOX_PORT_BASE"

section "CLI Self-host Setup"
$CLI self-host init --instance "$INSTANCE" --tag "$TAG" >/tmp/kortix-selfhost-init-$INSTANCE.log
$CLI self-host env set --instance "$INSTANCE" \
  "PUBLIC_URL=$PUBLIC_URL" \
  "API_PUBLIC_URL=$API_PUBLIC_URL" \
  "SUPABASE_PUBLIC_URL=$SUPABASE_PUBLIC_URL" \
  "FRONTEND_PORT=$FRONTEND_PORT" \
  "API_PORT=$API_PORT" \
  "SUPABASE_PORT=$SUPABASE_PORT" \
  "POSTGRES_PORT=$POSTGRES_PORT" \
  "SANDBOX_PORT_BASE=$SANDBOX_PORT_BASE" \
  "SANDBOX_CONTAINER_NAME=kortix-$INSTANCE-sandbox" \
  "KORTIX_LOCAL_IMAGES=$KORTIX_LOCAL_IMAGES" >/dev/null
if [ -n "$FRONTEND_IMAGE" ]; then
  $CLI self-host env set --instance "$INSTANCE" "FRONTEND_IMAGE=$FRONTEND_IMAGE" >/dev/null
fi
if [ -n "$API_IMAGE" ]; then
  $CLI self-host env set --instance "$INSTANCE" "API_IMAGE=$API_IMAGE" >/dev/null
fi
if [ -n "$SANDBOX_IMAGE" ]; then
  $CLI self-host env set --instance "$INSTANCE" "SANDBOX_IMAGE=$SANDBOX_IMAGE" >/dev/null
fi
ok "Config initialized without prompts"

section "Build Current Source Images"
bash "$SUNA_ROOT/scripts/build-local-images.sh" --tag selfhost-local
ok "Current-source images rebuilt"

section "Start Stack"
$CLI self-host start --instance "$INSTANCE" --tag "$TAG"
ok "Docker Compose started"

section "HTTP Health"
wait_for_json "API" "$API_PUBLIC_URL/v1/health" 180
wait_for_json "frontend runtime config" "$PUBLIC_URL/api/runtime-config" 180

source "$CONFIG_DIR/.env"
curl -fsS -H "apikey: $SUPABASE_ANON_KEY" "$SUPABASE_PUBLIC_URL/auth/v1/health" >/dev/null
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
USER_ID=$(printf '%s' "$TOKEN_JSON" | json_get user.id)
[ -n "$ACCESS_TOKEN" ] && [ -n "$USER_ID" ] || die "token exchange failed"
ok "Supabase password token exchange works"

section "Authenticated API"
ACCOUNTS_JSON=$(curl -fsS -H "authorization: Bearer $ACCESS_TOKEN" "$API_PUBLIC_URL/v1/accounts")
ACCOUNT_ID=$(printf '%s' "$ACCOUNTS_JSON" | json_get 0.account_id)
[ -n "$ACCOUNT_ID" ] || die "could not resolve account id"
ok "GET /v1/accounts works: $ACCOUNT_ID"

PROJECTS_JSON=$(curl -fsS -H "authorization: Bearer $ACCESS_TOKEN" "$API_PUBLIC_URL/v1/projects")
printf '%s' "$PROJECTS_JSON" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null
ok "GET /v1/projects works"

section "Seed Test Project"
PROJECT_ID=$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)
psql_selfhost <<SQL >/dev/null
insert into kortix.projects (
  project_id,
  account_id,
  name,
  repo_url,
  default_branch,
  manifest_path,
  status,
  metadata
) values (
  '$PROJECT_ID'::uuid,
  '$ACCOUNT_ID'::uuid,
  '$PROJECT_NAME',
  '$PROJECT_REPO_URL',
  'main',
  'kortix.toml',
  'active',
  '{"self_host_e2e":true}'::jsonb
);

insert into kortix.project_members (
  account_id,
  project_id,
  user_id,
  project_role,
  granted_by
) values (
  '$ACCOUNT_ID'::uuid,
  '$PROJECT_ID'::uuid,
  '$USER_ID'::uuid,
  'manager',
  '$USER_ID'::uuid
);

SQL
ok "Project and member seeded: $PROJECT_ID"

curl -fsS -H "authorization: Bearer $ACCESS_TOKEN" "$API_PUBLIC_URL/v1/projects/$PROJECT_ID/sessions" >/dev/null
ok "Seeded project is visible to API"

section "Create Local Docker Session"
SESSION_JSON=$(curl -fsS -X POST "$API_PUBLIC_URL/v1/projects/$PROJECT_ID/sessions" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"provider":"local_docker","base_ref":"main","name":"self-host e2e","branch_already_created":true}')
SESSION_ID=$(printf '%s' "$SESSION_JSON" | json_get session_id)
[ -n "$SESSION_ID" ] || die "session create failed: $SESSION_JSON"
ok "POST /v1/projects/:id/sessions works: $SESSION_ID"

section "Sandbox Health"
wait_for_sandbox_health "$SANDBOX_HEALTH_URL" 240
SANDBOX_HEALTH=$(curl -fsS "$SANDBOX_HEALTH_URL")
printf '%s' "$SANDBOX_HEALTH" | python3 -c 'import json, sys
body = json.load(sys.stdin)
status = body.get("status")
if status not in ("ok", "degraded"):
    raise SystemExit(f"unexpected sandbox health: {body}")'
ok "Sandbox /kortix/health returned healthy JSON"

section "CLI Host Registration"
$CLI hosts info selfhost >/dev/null
ok "CLI registered selfhost host"

section "Browser Playwright E2E"
export E2E_BASE_URL="$PUBLIC_URL"
export E2E_API_URL="$API_PUBLIC_URL/v1"
export E2E_SUPABASE_URL="$SUPABASE_PUBLIC_URL"
export E2E_ENV_FILE="$CONFIG_DIR/.env"
export E2E_OWNER_EMAIL="$EMAIL"
export E2E_OWNER_PASSWORD="$PASSWORD"
export E2E_COMPOSE_PROJECT_NAME="kortix-$INSTANCE"
export E2E_SANDBOX_CONTAINER_NAME="kortix-$INSTANCE-sandbox"
pnpm --dir "$SUNA_ROOT/tests" exec playwright test -c playwright.config.ts
ok "Playwright browser suite passed"

section "Result"
ok "Full self-host e2e passed"
note "Instance $INSTANCE was stopped and removed by cleanup."
