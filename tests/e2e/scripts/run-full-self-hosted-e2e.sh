#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPUTER_ROOT="$(cd "$SCRIPT_DIR/../../../../../" && pwd)"
INSTALL_LOG="$COMPUTER_ROOT/local-install-e2e.log"

cd "$COMPUTER_ROOT"

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

if [ -d "$HOME/.kortix" ]; then
  echo "[e2e] Cleaning existing ~/.kortix stack"
  docker compose -f "$HOME/.kortix/docker-compose.yml" down --remove-orphans --volumes >/dev/null 2>&1 || true
  rm -rf "$HOME/.kortix"
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

docker compose -f "$HOME/.kortix/docker-compose.yml" up -d kortix-api frontend >/dev/null

echo "[e2e] Verifying local endpoints"
wait_for_url "http://localhost:13737/auth"
wait_for_url "http://localhost:13738/v1/setup/install-status"

echo "[e2e] Installing Playwright browser if needed"
pnpm --dir apps/web exec playwright install chromium >/dev/null

echo "[e2e] Running full E2E auth/onboarding test"
pnpm --dir tests exec playwright test \
  -c playwright.config.ts \
  e2e/specs/04-auth-flow.spec.ts \
  e2e/specs/05-onboarding-to-dashboard.spec.ts

echo "[e2e] Full self-hosted E2E succeeded"
