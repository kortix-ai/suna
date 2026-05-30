#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INSTALL_DIR="${KORTIX_E2E_INSTALL_DIR:-${KORTIX_HOME:-$HOME/.kortix}}"
INSTALL_LOG="$COMPUTER_ROOT/local-install-e2e.log"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/^[._-]*//; s/[^a-z0-9_-]//g')}"
[ -n "$COMPOSE_PROJECT_NAME" ] || COMPOSE_PROJECT_NAME="kortix"

cd "$COMPUTER_ROOT"

export KORTIX_HOME="$INSTALL_DIR"
export COMPOSE_PROJECT_NAME
export SANDBOX_CONTAINER_NAME="${SANDBOX_CONTAINER_NAME:-${COMPOSE_PROJECT_NAME}-sandbox}"
export SANDBOX_PORT_BASE="${SANDBOX_PORT_BASE:-15000}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:13737}"
export E2E_API_URL="${E2E_API_URL:-http://localhost:13738/v1}"
export E2E_SUPABASE_URL="${E2E_SUPABASE_URL:-http://localhost:13740}"
export E2E_ENV_FILE="${E2E_ENV_FILE:-$INSTALL_DIR/.env}"

echo "[e2e] Starting full self-hosted install test"

wait_for_url() {
  local url="$1"
  local attempts="${2:-40}"
  local delay="${3:-2}"

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  echo "Timeout waiting for $url"
  return 1
}

if [ -d "$INSTALL_DIR" ]; then
  echo "[e2e] Cleaning existing stack at $INSTALL_DIR"
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    docker compose -f "$INSTALL_DIR/docker-compose.yml" down --remove-orphans --volumes >/dev/null 2>&1 || true
  fi
  docker ps -a \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --format '{{.Names}}' \
    | xargs -r docker rm -f 2>/dev/null || true
  docker rm -f "$SANDBOX_CONTAINER_NAME" 2>/dev/null || true
  docker volume ls \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --format '{{.Name}}' \
    | xargs -r docker volume rm -f 2>/dev/null || true
  docker volume rm "${SANDBOX_CONTAINER_NAME}-data" 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
fi

echo "[e2e] Running installer (local mode, minimal prompts)"
printf "y\n\n\n\nn\nn\n" | bash "scripts/get-kortix.sh" >"$INSTALL_LOG" 2>&1

echo "[e2e] Building local frontend image (multi-stage Docker build)"
docker build -f "apps/web/Dockerfile" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-http://localhost:8000}" \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" \
  --build-arg NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-http://localhost:8008/v1}" \
  -t "kortix/kortix-frontend:latest" . >/dev/null

echo "[e2e] Building local API image with current source"
docker build --build-arg SERVICE=kortix-api -f "apps/api/Dockerfile" -t "kortix/kortix-api:latest" . >/dev/null

docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d kortix-api frontend >/dev/null

echo "[e2e] Verifying local endpoints"
wait_for_url "http://localhost:13737/auth"
wait_for_url "http://localhost:13738/v1/setup/install-status"

echo "[e2e] Installing Playwright browser if needed"
pnpm --dir apps/web exec playwright install chromium >/dev/null

echo "[e2e] Running full E2E auth/onboarding test"
load_install_env() {
  local key="$1"
  grep -m1 "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2- || true
}

export SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-$(load_install_env SUPABASE_ANON_KEY)}"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-$SUPABASE_ANON_KEY}"
export SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-$(load_install_env SUPABASE_SERVICE_ROLE_KEY)}"
POSTGRES_PASSWORD_FOR_HOST="${POSTGRES_PASSWORD:-$(load_install_env POSTGRES_PASSWORD)}"
if [ -n "$POSTGRES_PASSWORD_FOR_HOST" ]; then
  export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:${POSTGRES_PASSWORD_FOR_HOST}@localhost:13741/postgres}"
fi

pnpm --dir tests exec playwright test \
  -c playwright.config.ts \
  e2e/specs/04-auth-flow.spec.ts \
  e2e/specs/08-accounts-project-access.spec.ts \
  e2e/specs/09-admin-ops.spec.ts \
  e2e/specs/10-production-golden-paths.spec.ts

echo "[e2e] Full self-hosted E2E succeeded"
