#!/usr/bin/env bash
#
# Fast self-host schema-bootstrap regression gate.
#
# Brings up ONLY the data plane (Postgres + Supabase Auth/REST/Kong + the
# kortix-migrate one-shot + the API) and asserts that a FRESH database is fully
# provisioned: the migrate one-shot installs the non-kortix prerequisites
# and applies all migrations, the API serves, an owner can be
# bootstrapped, and authenticated reads resolve an account.
#
# This is the cheap counterpart to run.sh — it needs only the API image, so it
# is a quick PR gate against the "self-host boots an empty schema" regression.
# It does NOT exercise the frontend, llm-gateway, or the agent sandbox path;
# run.sh covers those.
#
# Requires: the API image to exist locally (default kortix/kortix-api:selfhost-local).

set -Eeuo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
CLI="bun run $CLI_ROOT/src/index.ts"

INSTANCE=${INSTANCE:-selfhost-schema-$(date +%s)}
API_IMAGE=${API_IMAGE:-kortix/kortix-api:selfhost-local}
EMAIL=${EMAIL:-owner-$INSTANCE@kortix.local}
PASSWORD=${PASSWORD:-kortix-schema-pass}
CONFIG_DIR="$HOME/.config/kortix/self-host/$INSTANCE"
KEEP_ON_FAIL=${KEEP_ON_FAIL:-false}

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
section() { printf "\n${BOLD}== %s ==${RESET}\n" "$1"; }
ok() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
note() { printf "  ${DIM}%s${RESET}\n" "$1"; }
die() { printf "  ${RED}✗${RESET} %s\n" "$1" >&2; exit 1; }

compose() { docker compose --project-name "kortix-$INSTANCE" --env-file "$CONFIG_DIR/.env" -f "$CONFIG_DIR/docker-compose.yml" "$@"; }
psqls() { compose exec -T supabase-db psql -v ON_ERROR_STOP=0 -tAU postgres -d postgres "$@" 2>&1; }

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

cleanup() {
  local rc=$?
  set +e
  if [ "$rc" -ne 0 ] && [ "$KEEP_ON_FAIL" = "true" ]; then
    note "Keeping failed stack for inspection: $INSTANCE"; return "$rc"
  fi
  compose down --remove-orphans --volumes >/dev/null 2>&1
}
trap cleanup EXIT

section "Allocate Isolated Ports"
read -r FRONTEND_PORT API_PORT SUPABASE_PORT POSTGRES_PORT <<<"$(python3 - <<'PY'
import socket
ports=[]
for _ in range(4):
    s=socket.socket(); s.bind(("127.0.0.1",0)); ports.append(s.getsockname()[1])
print(" ".join(map(str, ports)))
PY
)"
ok "instance $INSTANCE (api port $API_PORT)"

section "CLI Self-host Setup"
# --allow-missing-secrets: init now enforces required secrets (managed-git /
# Daytona / OpenRouter) and fails without them; this schema-only gate supplies
# dummy creds via `env set` immediately below, so downgrade the gate to a warning.
$CLI self-host init --instance "$INSTANCE" --allow-missing-secrets >/dev/null
# Schema-only gate: this never provisions a sandbox. `self-host init` defaults
# the provider to daytona, which makes env-validation require Daytona creds, so
# supply dummy ones — they only need to be present for the API to boot; Daytona
# is never actually called during a schema check (provider use is lazy).
$CLI self-host env set --instance "$INSTANCE" \
  "API_PUBLIC_URL=http://localhost:$API_PORT" \
  "SUPABASE_PUBLIC_URL=http://localhost:$SUPABASE_PORT" \
  "API_PORT=$API_PORT" "SUPABASE_PORT=$SUPABASE_PORT" "POSTGRES_PORT=$POSTGRES_PORT" \
  "FRONTEND_PORT=$FRONTEND_PORT" \
  "ALLOWED_SANDBOX_PROVIDERS=daytona" \
  "DAYTONA_API_KEY=schema-check-dummy" \
  "DAYTONA_SERVER_URL=https://daytona.invalid" \
  "DAYTONA_TARGET=schema-check" \
  "KORTIX_LOCAL_IMAGES=true" \
  "API_IMAGE=$API_IMAGE" >/dev/null
ok "config initialized"

section "Bring Up Data Plane (db, auth, rest, kong, migrate, api)"
# Start the schema gate's deliberately small service set explicitly. The full
# official Supabase graph makes Kong wait for Studio, which in turn starts the
# analytics stack; that is correct for a real full-stack boot but wastes CI
# resources and made this focused gate vulnerable to unrelated Logflare/Studio
# startup timing. `--no-deps` keeps this test honest about exactly what it uses.
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

section "Schema Bootstrap (migrate one-shot)"
MIGRATE_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "kortix-$INSTANCE-kortix-migrate-1" 2>/dev/null || echo missing)
[ "$MIGRATE_EXIT" = "0" ] || { compose logs kortix-migrate 2>&1 | tail -30 >&2; die "kortix-migrate one-shot failed (exit=$MIGRATE_EXIT)"; }
ok "kortix-migrate one-shot completed (exit 0)"

KTABLES=$(psqls -c "select count(*) from information_schema.tables where table_schema='kortix'" | tr -d '[:space:]')
[ "${KTABLES:-0}" -ge 50 ] || die "expected >=50 kortix tables, got '$KTABLES'"
ok "kortix schema provisioned ($KTABLES tables)"
[ "$(psqls -c "select to_regclass('kortix.account_members')")" = "kortix.account_members" ] || die "kortix.account_members missing"
ok "kortix account tables present"
[ "$(psqls -c "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname='users' and t.tgname='on_auth_user_created'")" = "0" ] || die "legacy basejump signup trigger still installed"
ok "no basejump signup trigger (accounts are kortix-native)"

section "API Health"
START=$(date +%s)
until curl -fsS "http://localhost:$API_PORT/v1/health" >/dev/null 2>&1; do
  [ $(( $(date +%s) - START )) -ge 120 ] && { compose logs kortix-api 2>&1 | tail -30 >&2; die "API never became healthy"; }
  sleep 2
done
ok "API healthy"

section "Bootstrap Owner + Authenticated Read"
BODY=$(printf '{"email":"%s","password":"%s"}' "$EMAIL" "$PASSWORD")
BO=$(curl -fsS -X POST "http://localhost:$API_PORT/v1/setup/bootstrap-owner" -H 'content-type: application/json' -d "$BODY")
printf '%s' "$BO" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)' || die "bootstrap-owner failed: $BO"
ok "owner bootstrapped"

source "$CONFIG_DIR/.env"
TOK=$(curl -fsS -X POST "http://localhost:$SUPABASE_PORT/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_ANON_KEY" -H 'content-type: application/json' -d "$BODY")
ACCESS=$(printf '%s' "$TOK" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')
[ -n "$ACCESS" ] || die "token exchange failed"
ACC=$(curl -fsS -H "authorization: Bearer $ACCESS" "http://localhost:$API_PORT/v1/accounts")
printf '%s' "$ACC" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d and d[0].get("account_id") else 1)' || die "GET /v1/accounts did not resolve an account: $ACC"
ok "authenticated GET /v1/accounts resolves owner account"

section "Result"
ok "self-host schema-bootstrap check passed"
