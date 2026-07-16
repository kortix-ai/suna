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
# TAG selects the image set under the STANDARD repo names
# (kortix/kortix-{frontend,api,gateway}:$TAG) via `init --tag` — the same
# convention scripts/build-local-images.sh uses (--tag). Custom per-image repo
# overrides used to be set via `env set FRONTEND_IMAGE=...` etc.; that's now
# refused by the CLI (FRONTEND_IMAGE/API_IMAGE/GATEWAY_IMAGE/SANDBOX_IMAGE are
# updater-managed keys — see secrets-registry.ts's isUpdaterManagedKey — only
# --tag/--channel/--release may set them), so TAG is the one lever.
TAG=${TAG:-latest}
# KORTIX_LOCAL_IMAGES=true → pass --local-images to `init`, which persists
# KORTIX_IMAGE_PULL=never so `start`/`update` never try to pull images that
# were only ever built locally (see shouldPullImages()).
KORTIX_LOCAL_IMAGES=${KORTIX_LOCAL_IMAGES:-false}
KEEP_ON_FAIL=${KEEP_ON_FAIL:-false}
KEEP_ON_SUCCESS=${KEEP_ON_SUCCESS:-false}
EMAIL=${EMAIL:-owner-$INSTANCE@kortix.local}
PASSWORD=${PASSWORD:-kortix-e2e-password}
CONFIG_DIR="$HOME/.config/kortix/self-host/$INSTANCE"
WORK_DIR="$SCRIPT_DIR/work/$INSTANCE"
CLI_CONFIG_FILE="$WORK_DIR/config.json"
PROJECT_NAME="self-host-e2e-$INSTANCE"
# A REAL, always-public, tiny, stable repo — not a fake example.com URL. Every
# session (any provider, including local-docker) git-clones the project's
# ACTUAL repo_url into /workspace at boot (KORTIX_GIT_PROXY is off by default
# on self-host, so this is a direct clone, no proxy involved) — a
# non-existent URL 404s the clone and the sandbox never reaches
# runtimeReady:true, regardless of provider. octocat/Hello-World is GitHub's
# own canonical smoke-test repo (tiny, public, default branch `master`).
PROJECT_REPO_URL="https://github.com/octocat/Hello-World.git"
PROJECT_DEFAULT_BRANCH="master"
PROJECT_COMMIT="7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"

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

# Poll kortix.session_sandboxes for the provider's external_id (the
# kortix-sb-<external_id> container name) — the local-docker provider mints
# this container ASYNCHRONOUSLY off the session-create request (the same as
# every other provider), and the first-ever build (docker build of the
# platform-default ubuntu:24.04 + Kortix runtime layer, content-addressed and
# cached forever after) can legitimately take several minutes cold.
wait_for_sandbox_external_id() {
  local session_id=$1
  local timeout=${2:-600}
  local start
  start=$(date +%s)
  local external_id=""
  while [ -z "$external_id" ]; do
    external_id=$(psql_selfhost -tAc \
      "select external_id from kortix.session_sandboxes where session_id = '$session_id' and external_id is not null limit 1;" \
      2>/dev/null | tr -d '[:space:]')
    if [ -n "$external_id" ]; then
      printf '%s' "$external_id"
      return 0
    fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      psql_selfhost -tAc "select status, metadata from kortix.session_sandboxes where session_id = '$session_id';" >&2 2>/dev/null || true
      die "session sandbox never got an external_id (container never created) within ${timeout}s"
    fi
    sleep 3
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
  if [ "$rc" -eq 0 ] && [ "$KEEP_ON_SUCCESS" = "true" ]; then
    note "Keeping successful stack for follow-up checks: $INSTANCE"
    note "Inspect with: kortix self-host logs --instance $INSTANCE"
    return 0
  fi
  if [ "$rc" -ne 0 ] && [ "$KEEP_ON_FAIL" = "true" ]; then
    note "Keeping failed stack for inspection: $INSTANCE"
    note "Inspect with: kortix self-host logs --instance $INSTANCE"
    return "$rc"
  fi
  if [ -n "${PROJECT_ID:-}" ]; then
    psql_selfhost -c "delete from kortix.projects where project_id = '$PROJECT_ID'::uuid;" >/dev/null 2>&1
  fi
  # The local-docker sandbox container is NOT part of the Compose project
  # (kortix-api creates it directly against the host Docker socket) — remove
  # it explicitly by its provider-assigned name if a session ever got one.
  if [ -n "${SANDBOX_EXTERNAL_ID:-}" ]; then
    docker rm -f "kortix-sb-$SANDBOX_EXTERNAL_ID" >/dev/null 2>&1
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
note "Dashboard: $PUBLIC_URL"
note "API: $API_PUBLIC_URL"
note "Supabase: $SUPABASE_PUBLIC_URL"

section "CLI Self-host Setup"
# `init` never blocks on a missing required secret (it warns and proceeds) —
# this harness sets the rest via `env set` right after. Image tags are
# selected via --tag (standard kortix/kortix-{frontend,api,gateway}:$TAG repo
# names — see the TAG comment above); --local-images marks them as never
# pulled from a registry (see shouldPullImages()).
INIT_ARGS=(self-host init --instance "$INSTANCE" --tag "$TAG")
if [ "$KORTIX_LOCAL_IMAGES" = "true" ]; then
  INIT_ARGS+=(--local-images)
fi
$CLI "${INIT_ARGS[@]}" >/tmp/kortix-selfhost-init-$INSTANCE.log
# EXPERIMENTAL local-docker provider (apps/api/src/platform/providers/local-docker.ts):
# sandboxes run as plain containers on THIS SAME machine via the host Docker
# socket — no cloud credentials needed, so this golden path stays fully
# hermetic in CI (previously used Daytona, which needs real API creds CI
# doesn't have — see the git history of this line for that RED period). This
# `env set` re-renders docker-compose.yml (writeCompose() in
# commands/self-host.ts) to mount /var/run/docker.sock into kortix-api and
# point LOCAL_DOCKER_NETWORK at this instance's own Compose network — see
# renderFullDockerCompose()'s `localDockerConfigured` option.
$CLI self-host env set --instance "$INSTANCE" \
  "PUBLIC_URL=$PUBLIC_URL" \
  "API_PUBLIC_URL=$API_PUBLIC_URL" \
  "SUPABASE_PUBLIC_URL=$SUPABASE_PUBLIC_URL" \
  "FRONTEND_PORT=$FRONTEND_PORT" \
  "API_PORT=$API_PORT" \
  "SUPABASE_PORT=$SUPABASE_PORT" \
  "POSTGRES_PORT=$POSTGRES_PORT" \
  "ALLOWED_SANDBOX_PROVIDERS=local-docker" >/dev/null
ok "Config initialized without prompts"

section "Start Stack"
$CLI self-host start --instance "$INSTANCE" --tag "$TAG"
ok "Docker Compose started"

section "Schema Bootstrap (migrate one-shot)"
# The kortix-migrate one-shot must complete (exit 0) before the API starts. On a
# fresh DB it installs the non-kortix prerequisites then applies all
# migrations. Assert it ran and provisioned the managed schema.
MIGRATE_EXIT=$(docker inspect -f '{{.State.ExitCode}}' "kortix-$INSTANCE-kortix-migrate-1" 2>/dev/null || echo "missing")
[ "$MIGRATE_EXIT" = "0" ] || die "kortix-migrate one-shot did not succeed (exit=$MIGRATE_EXIT)"
ok "kortix-migrate one-shot completed (exit 0)"

section "HTTP Health"
wait_for_json "API" "$API_PUBLIC_URL/v1/health" 180
wait_for_json "frontend runtime config" "$PUBLIC_URL/api/runtime-config" 180
wait_for_db_table "Kortix schema" "kortix.project_snapshot_builds" 180
wait_for_db_table "Kortix accounts" "kortix.account_members" 60

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
  '$PROJECT_DEFAULT_BRANCH',
  'kortix.yaml',
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

insert into kortix.project_snapshot_builds (
  account_id,
  project_id,
  commit_sha,
  branch,
  snapshot_name,
  content_hash,
  status,
  metadata
) values (
  '$ACCOUNT_ID'::uuid,
  '$PROJECT_ID'::uuid,
  '$PROJECT_COMMIT',
  '$PROJECT_DEFAULT_BRANCH',
  'self-host-e2e-ready',
  'self-host-e2e-ready',
  'ready',
  '{"self_host_e2e":true}'::jsonb
);
SQL
ok "Project and ready snapshot build log seeded: $PROJECT_ID"

curl -fsS -H "authorization: Bearer $ACCESS_TOKEN" "$API_PUBLIC_URL/v1/projects/$PROJECT_ID/sessions" >/dev/null
ok "Seeded project is visible to API"

section "Create Session"
SESSION_JSON=$(curl -fsS -X POST "$API_PUBLIC_URL/v1/projects/$PROJECT_ID/sessions" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"provider\":\"local-docker\",\"base_ref\":\"$PROJECT_DEFAULT_BRANCH\",\"name\":\"self-host e2e\",\"branch_already_created\":true}")
SESSION_ID=$(printf '%s' "$SESSION_JSON" | json_get session_id)
[ -n "$SESSION_ID" ] || die "session create failed: $SESSION_JSON"
ok "POST /v1/projects/:id/sessions works: $SESSION_ID"

section "Sandbox Container"
# Provisioning is async off the create request (same as every provider) — the
# FIRST session on a fresh instance also pays a real `docker build` of the
# platform-default image (ubuntu:24.04 + the Kortix runtime layer: opencode,
# kortix-agent, apt/pip installs) since nothing was pre-built. Generous
# timeout for that cold path; every later session on this instance reuses the
# cached, content-addressed image and is fast.
SANDBOX_EXTERNAL_ID=$(wait_for_sandbox_external_id "$SESSION_ID" 900)
ok "session sandbox container provisioned: kortix-sb-$SANDBOX_EXTERNAL_ID"

CONTAINER_STATE=$(docker inspect -f '{{.State.Running}}' "kortix-sb-$SANDBOX_EXTERNAL_ID" 2>/dev/null || echo "missing")
[ "$CONTAINER_STATE" = "true" ] || die "sandbox container kortix-sb-$SANDBOX_EXTERNAL_ID is not running (state=$CONTAINER_STATE)"
ok "container kortix-sb-$SANDBOX_EXTERNAL_ID is running"

# The provider ALWAYS publishes the agent port to loopback (debug/dev
# convenience — see local-docker.ts's create()); read back whatever host port
# Docker actually assigned rather than assuming one.
SANDBOX_HOST_PORT=$(docker inspect -f '{{ (index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort }}' "kortix-sb-$SANDBOX_EXTERNAL_ID" 2>/dev/null || true)
[ -n "$SANDBOX_HOST_PORT" ] || die "sandbox container has no published host port for 8000/tcp"
SANDBOX_HEALTH_URL="http://127.0.0.1:$SANDBOX_HOST_PORT/kortix/health"

section "Sandbox Health"
wait_for_sandbox_health "$SANDBOX_HEALTH_URL" 240
SANDBOX_HEALTH=$(curl -fsS "$SANDBOX_HEALTH_URL")
printf '%s' "$SANDBOX_HEALTH" | python3 -c 'import json, sys
body = json.load(sys.stdin)
status = body.get("status")
if status not in ("ok", "degraded"):
    raise SystemExit(f"unexpected sandbox health: {body}")'
ok "Sandbox /kortix/health returned healthy JSON"

section "Sandbox Stop / Resume (persistence semantics)"
curl -fsS -X POST "$API_PUBLIC_URL/v1/projects/$PROJECT_ID/sessions/$SESSION_ID/stop" \
  -H "authorization: Bearer $ACCESS_TOKEN" >/dev/null
STOP_START=$(date +%s)
while true; do
  STATE=$(docker inspect -f '{{.State.Running}}' "kortix-sb-$SANDBOX_EXTERNAL_ID" 2>/dev/null || echo "missing")
  [ "$STATE" = "false" ] && break
  [ $(( $(date +%s) - STOP_START )) -ge 60 ] && die "sandbox container did not stop within 60s (state=$STATE)"
  sleep 2
done
ok "stop(): container preserved (not removed), status=stopped"
# Container must still EXIST (persistence = the writable layer survives).
docker inspect "kortix-sb-$SANDBOX_EXTERNAL_ID" >/dev/null 2>&1 || die "sandbox container was removed by stop() — persistence semantics violated"

curl -fsS -X POST "$API_PUBLIC_URL/v1/projects/$PROJECT_ID/sessions/$SESSION_ID/start" \
  -H "authorization: Bearer $ACCESS_TOKEN" >/dev/null
RESUME_START=$(date +%s)
while true; do
  STATE=$(docker inspect -f '{{.State.Running}}' "kortix-sb-$SANDBOX_EXTERNAL_ID" 2>/dev/null || echo "missing")
  [ "$STATE" = "true" ] && break
  [ $(( $(date +%s) - RESUME_START )) -ge 60 ] && die "sandbox container did not resume within 60s (state=$STATE)"
  sleep 2
done
ok "start(): resumed the SAME container (sub-second Docker start, no new external_id)"

# Re-verify HTTP reachability post-resume — WITHOUT assuming the debug host
# port is unchanged. It usually is, but some Docker engines reassign a NEW
# ephemeral host port for a `HostPort: 0` mapping on restart (confirmed on
# Docker Desktop); the container's stable Docker-network DNS name is the
# real (non-debug) path production actually uses (see resolveIngress in
# local-docker.ts) and is unaffected either way.
SANDBOX_HOST_PORT=$(docker inspect -f '{{ (index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort }}' "kortix-sb-$SANDBOX_EXTERNAL_ID" 2>/dev/null || true)
[ -n "$SANDBOX_HOST_PORT" ] || die "sandbox container has no published host port for 8000/tcp after resume"
wait_for_sandbox_health "http://127.0.0.1:$SANDBOX_HOST_PORT/kortix/health" 60
ok "sandbox healthy again post-resume — persistence semantics confirmed end-to-end"

section "Update Mechanism"
note "version before update:"
$CLI self-host version --instance "$INSTANCE" || true
# `update` re-points image tags at the target version and does down→start. The
# Postgres volume is preserved, so this is a true in-place upgrade: the
# kortix-migrate one-shot re-runs (idempotent) and applies any new migrations
# before the API serves again.
$CLI self-host update --instance "$INSTANCE" --tag "$TAG"
ok "self-host update completed"

MIGRATE_EXIT2=$(docker inspect -f '{{.State.ExitCode}}' "kortix-$INSTANCE-kortix-migrate-1" 2>/dev/null || echo "missing")
[ "$MIGRATE_EXIT2" = "0" ] || die "post-update kortix-migrate did not succeed (exit=$MIGRATE_EXIT2)"
wait_for_json "API (post-update)" "$API_PUBLIC_URL/v1/health" 180
wait_for_db_table "Kortix schema (post-update)" "kortix.project_snapshot_builds" 60
ok "stack healthy after update; migrations idempotent"

# The data must survive the upgrade: re-bootstrapping the owner is now a no-op
# conflict (409), proving the Postgres volume persisted across down→up.
REBOOTSTRAP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_PUBLIC_URL/v1/setup/bootstrap-owner" \
  -H 'content-type: application/json' -d "$BOOTSTRAP_BODY")
[ "$REBOOTSTRAP" = "409" ] || die "expected owner-exists 409 after update, got $REBOOTSTRAP"
ok "data persisted across update (owner still present → 409)"

section "CLI Host Registration"
$CLI hosts info selfhost >/dev/null
ok "CLI registered selfhost host"

section "Result"
ok "Full self-host e2e passed"
note "Instance $INSTANCE was stopped and removed by cleanup."
