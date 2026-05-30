#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix — Full Self-Hosted E2E Test                                        ║
# ║                                                                            ║
# ║  Runs the complete flow a real user would experience:                      ║
# ║    1. Clean slate (nuke any existing install)                              ║
# ║    2. Build local Docker images                                            ║
# ║    3. Run get-kortix.sh installer                                          ║
# ║    4. Wait for all services to be healthy                                  ║
# ║    5. Run Playwright browser tests (auth, wizard, dashboard)               ║
# ║                                                                            ║
# ║  Usage:                                                                    ║
# ║    cd computer && bash tests/e2e/self-hosted-e2e.sh                        ║
# ║    bash tests/e2e/self-hosted-e2e.sh --skip-build   # reuse images         ║
# ║    bash tests/e2e/self-hosted-e2e.sh --skip-install # reuse install        ║
# ║    bash tests/e2e/self-hosted-e2e.sh --browser-only # just playwright      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="${KORTIX_E2E_INSTALL_DIR:-${KORTIX_HOME:-$HOME/.kortix}}"
INSTALL_LOG="$REPO_ROOT/test-results/install.log"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/^[._-]*//; s/[^a-z0-9_-]//g')}"
[ -n "$COMPOSE_PROJECT_NAME" ] || COMPOSE_PROJECT_NAME="kortix"
export KORTIX_HOME="$INSTALL_DIR"
export COMPOSE_PROJECT_NAME
export SANDBOX_CONTAINER_NAME="${SANDBOX_CONTAINER_NAME:-${COMPOSE_PROJECT_NAME}-sandbox}"
export SANDBOX_PORT_BASE="${SANDBOX_PORT_BASE:-15000}"

# ── Config ────────────────────────────────────────────────────────────────────
export E2E_OWNER_EMAIL="${E2E_OWNER_EMAIL:-test-e2e@kortix.ai}"
export E2E_OWNER_PASSWORD="${E2E_OWNER_PASSWORD:-e2e-testpass-123}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:13737}"
export E2E_API_URL="${E2E_API_URL:-http://localhost:13738/v1}"
export E2E_SUPABASE_URL="${E2E_SUPABASE_URL:-http://localhost:13740}"
export E2E_SANDBOX_HEALTH_URL="${E2E_SANDBOX_HEALTH_URL:-http://localhost:${SANDBOX_PORT_BASE}/kortix/health}"
export E2E_ENV_FILE="${E2E_ENV_FILE:-$INSTALL_DIR/.env}"

# ── Flags ─────────────────────────────────────────────────────────────────────
SKIP_BUILD=false
SKIP_INSTALL=false
BROWSER_ONLY=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build)   SKIP_BUILD=true;   shift ;;
    --skip-install) SKIP_INSTALL=true; SKIP_BUILD=true; shift ;;
    --browser-only) BROWSER_ONLY=true; SKIP_INSTALL=true; SKIP_BUILD=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# ── Colors ────────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; NC=$'\033[0m'

step()    { echo ""; echo "${BOLD}${CYAN}══ $1${NC}"; }
info()    { echo "  ${BLUE}[e2e]${NC} $*"; }
pass()    { echo "  ${GREEN}[PASS]${NC} $*"; }
fail()    { echo "  ${RED}[FAIL]${NC} $*" >&2; }

env_value_from_file() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  grep -m1 "^${key}=" "$file" 2>/dev/null | cut -d= -f2- || true
}

install_env_has_key() {
  local key="$1"
  [ -f "$INSTALL_DIR/.env" ] && grep -q "^${key}=" "$INSTALL_DIR/.env"
}

upsert_install_env_key() {
  local key="$1" value="$2"
  [ -n "$value" ] || return 1
  mkdir -p "$INSTALL_DIR"
  touch "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  local tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$INSTALL_DIR/.env" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
}

propagate_github_env_for_golden_paths() {
  [ "${E2E_ENABLE_GOLDEN_PATHS:-0}" = "1" ] || return 0
  [ -f "$INSTALL_DIR/.env" ] || return 0

  local changed=0 key value existing
  for key in \
    KORTIX_GITHUB_APP_ID \
    KORTIX_GITHUB_APP_PRIVATE_KEY \
    KORTIX_GITHUB_APP_SLUG \
    KORTIX_GITHUB_TOKEN \
    KORTIX_GITHUB_OWNER \
    GITHUB_APP_ID \
    GITHUB_APP_PRIVATE_KEY \
    GITHUB_APP_SLUG \
    GITHUB_TOKEN; do
    value="${!key-}"
    [ -n "$value" ] || value="$(env_value_from_file "$key" "$REPO_ROOT/apps/api/.env")"
    [ -n "$value" ] || continue

    existing="$(env_value_from_file "$key" "$INSTALL_DIR/.env")"
    if [ "$existing" != "$value" ]; then
      upsert_install_env_key "$key" "$value"
      changed=1
    fi
  done

  if [ "$changed" = "1" ]; then
    info "Injected optional GitHub env for golden paths"
    if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
      docker compose -f "$INSTALL_DIR/docker-compose.yml" up -d --force-recreate kortix-api >/dev/null 2>&1 || true
    fi
  elif ! install_env_has_key KORTIX_GITHUB_TOKEN && ! install_env_has_key GITHUB_TOKEN && ! install_env_has_key KORTIX_GITHUB_APP_ID && ! install_env_has_key GITHUB_APP_ID; then
    info "Golden paths enabled but no GitHub env was found; create-repo checks may fail"
  fi
}

cd "$REPO_ROOT"
mkdir -p test-results

echo ""
echo "${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════╗"
echo "  ║  Kortix Self-Hosted E2E Test Suite            ║"
echo "  ╚═══════════════════════════════════════════════╝"
echo "${NC}"

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1: Clean slate
# ═══════════════════════════════════════════════════════════════════════════════
if [ "$BROWSER_ONLY" = "false" ] && [ "$SKIP_INSTALL" = "false" ]; then
  step "PHASE 1: Clean slate"

  info "Stopping existing containers for $COMPOSE_PROJECT_NAME..."
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    docker compose -f "$INSTALL_DIR/docker-compose.yml" down --remove-orphans --volumes >/dev/null 2>&1 || true
  fi
  docker ps -a \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --format '{{.Names}}' \
    | xargs -r docker rm -f 2>/dev/null || true
  docker rm -f "$SANDBOX_CONTAINER_NAME" 2>/dev/null || true

  info "Removing Docker volumes for $COMPOSE_PROJECT_NAME..."
  docker volume ls \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --format '{{.Name}}' \
    | xargs -r docker volume rm -f 2>/dev/null || true
  docker volume rm "${SANDBOX_CONTAINER_NAME}-data" 2>/dev/null || true

  info "Removing Kortix installation dir: $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"

  info "Freeing ports..."
  for port in 13737 13738 13740 13741 14000; do
    lsof -t -i:$port 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  done

  pass "Clean slate ready"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2: Build local Docker images
# ═══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_BUILD" = "false" ]; then
  step "PHASE 2: Build local Docker images"

  info "Running scripts/build-local-images.sh ..."
  bash scripts/build-local-images.sh --tag latest 2>&1 | tail -5

  pass "All images built"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3: Run get-kortix.sh installer
# ═══════════════════════════════════════════════════════════════════════════════
if [ "$SKIP_INSTALL" = "false" ]; then
  step "PHASE 3: Run get-kortix.sh installer"

  export KORTIX_OWNER_EMAIL="$E2E_OWNER_EMAIL"
  export KORTIX_OWNER_PASSWORD="$E2E_OWNER_PASSWORD"

  info "Running installer (local mode, Docker DB, skip integrations)..."
  # stdin: 1=local, 1=docker db, testpass123=confirm password, n=skip integrations
  printf "1\n1\n${E2E_OWNER_PASSWORD}\nn\n" | bash scripts/get-kortix.sh --local >"$INSTALL_LOG" 2>&1 || {
    fail "Installer failed. Log: $INSTALL_LOG"
    tail -30 "$INSTALL_LOG"
    exit 1
  }

  if [ -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    pass "Installer completed, stack config written"
  else
    fail "Stack config missing after install"
    exit 1
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Wait for services
# ═══════════════════════════════════════════════════════════════════════════════
propagate_github_env_for_golden_paths

step "PHASE 4: Wait for services"

wait_for_url() {
  local url="$1" label="$2" max="${3:-60}"
  for i in $(seq 1 "$max"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      pass "$label"
      return 0
    fi
    sleep 2
  done
  fail "$label (timeout after ${max}x2s)"
  return 1
}

wait_for_supabase_auth() {
  local base_url="$1" label="$2" max="${3:-60}"
  local anon_key=""
  if [ -f "$INSTALL_DIR/.env" ]; then
    anon_key=$(grep -m1 '^SUPABASE_ANON_KEY=' "$INSTALL_DIR/.env" | cut -d= -f2- || true)
  fi

  for i in $(seq 1 "$max"); do
    if [ -n "$anon_key" ] && curl -fsS "$base_url/auth/v1/health" -H "apikey: $anon_key" >/dev/null 2>&1; then
      pass "$label"
      return 0
    fi
    sleep 2
  done
  fail "$label (timeout after ${max}x2s)"
  return 1
}

wait_for_url "$E2E_BASE_URL/auth"               "Frontend :13737"
wait_for_url "${E2E_API_URL}/health"             "API :13738"     30
wait_for_supabase_auth "$E2E_SUPABASE_URL"       "Supabase :13740" 30

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

info "Bootstrapping owner account..."
BOOTSTRAP_RESPONSE=$(curl -sS -X POST "${E2E_API_URL}/setup/bootstrap-owner" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${E2E_OWNER_EMAIL}\",\"password\":\"${E2E_OWNER_PASSWORD}\"}") || true
if printf '%s' "$BOOTSTRAP_RESPONSE" | grep -q '"success":true'; then
  {
    printf 'Email: %s\n' "$E2E_OWNER_EMAIL"
    printf 'Password: %s\n' "$E2E_OWNER_PASSWORD"
  } > "$INSTALL_DIR/.credentials"
  chmod 600 "$INSTALL_DIR/.credentials"
  pass "Owner account ready"
elif curl -fsS "${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${E2E_OWNER_EMAIL}\",\"password\":\"${E2E_OWNER_PASSWORD}\"}" >/dev/null 2>&1; then
  pass "Owner account already usable"
else
  fail "Owner bootstrap returned unexpected response: $BOOTSTRAP_RESPONSE"
  exit 1
fi

# Repo-first golden paths start session sandboxes explicitly. This optional
# check is only for legacy/default always-on sandbox smoke coverage.
if [ "${E2E_WAIT_FOR_SANDBOX_HEALTH:-0}" = "1" ]; then
  wait_for_url "$E2E_SANDBOX_HEALTH_URL" "Sandbox :${SANDBOX_PORT_BASE}" 90 || info "(sandbox health timeout — tests will retry)"
else
  info "Skipping sandbox health wait (set E2E_WAIT_FOR_SANDBOX_HEALTH=1 to require it)"
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5: Run Playwright browser tests
# ═══════════════════════════════════════════════════════════════════════════════
step "PHASE 5: Playwright browser tests"

cd "$REPO_ROOT/tests"

# Install deps + browser if needed
if [ ! -d node_modules ]; then
  info "Installing test dependencies..."
  npm install --silent 2>/dev/null
fi

info "Ensuring Chromium is available..."
npx playwright install chromium 2>/dev/null

info "Running specs..."
PLAYWRIGHT_ARGS=(
  -c playwright.config.ts
  e2e/specs/04-auth-flow.spec.ts
  e2e/specs/08-accounts-project-access.spec.ts
  e2e/specs/09-admin-ops.spec.ts
  e2e/specs/10-production-golden-paths.spec.ts
  e2e/specs/11-production-boundaries.spec.ts
)

if [ -n "${GATE5_SELF_HOSTED_EVIDENCE_DIR:-}" ]; then
  if ! command -v jq >/dev/null 2>&1; then
    fail "jq is required when GATE5_SELF_HOSTED_EVIDENCE_DIR is set"
    exit 1
  fi
  mkdir -p "$GATE5_SELF_HOSTED_EVIDENCE_DIR"
  export PLAYWRIGHT_JSON_OUTPUT_FILE="$GATE5_SELF_HOSTED_EVIDENCE_DIR/playwright-report.json"
  set +e
  npx playwright test "${PLAYWRIGHT_ARGS[@]}" --reporter=line,json 2>&1 | tee "$GATE5_SELF_HOSTED_EVIDENCE_DIR/playwright.log"
  RESULT=${PIPESTATUS[0]}
  set -e
  status="passed"
  if [ "$RESULT" -ne 0 ]; then
    status="failed"
  fi
  jq -n \
    --arg status "$status" \
    --arg generated_at "$(date -u +"%Y%m%dT%H%M%SZ")" \
    --arg evidence_dir "$GATE5_SELF_HOSTED_EVIDENCE_DIR" \
    --arg base_url "$E2E_BASE_URL" \
    --arg api_url "$E2E_API_URL" \
    --arg supabase_url "$E2E_SUPABASE_URL" \
    --arg golden_paths_enabled "${E2E_ENABLE_GOLDEN_PATHS:-0}" \
    --arg local_docker_golden_enabled "${E2E_GOLDEN_LOCAL_DOCKER:-0}" \
    --arg golden_backpressure_enabled "${E2E_GOLDEN_BACKPRESSURE:-0}" \
    --arg provider "${E2E_GOLDEN_PROVIDER:-}" \
    '{
      evidence_contract_version: 1,
      status: $status,
      generated_at: $generated_at,
      evidence_dir: $evidence_dir,
      base_url: $base_url,
      api_url: $api_url,
      supabase_url: $supabase_url,
      golden_paths_enabled: $golden_paths_enabled,
      local_docker_golden_enabled: $local_docker_golden_enabled,
      golden_backpressure_enabled: $golden_backpressure_enabled,
      provider: $provider,
      artifacts: {
        playwright_report: "playwright-report.json",
        playwright_log: "playwright.log"
      }
    }' > "$GATE5_SELF_HOSTED_EVIDENCE_DIR/summary.json"
else
  npx playwright test "${PLAYWRIGHT_ARGS[@]}" 2>&1
  RESULT=$?
fi

echo ""
if [ $RESULT -eq 0 ]; then
  echo "${GREEN}${BOLD}  ✅  All E2E tests passed!${NC}"
  echo ""
  echo "  Dashboard: ${CYAN}${E2E_BASE_URL}/dashboard${NC}"
  echo "  Login:     ${CYAN}${E2E_OWNER_EMAIL}${NC} / ${CYAN}${E2E_OWNER_PASSWORD}${NC}"
else
  echo "${RED}${BOLD}  ❌  E2E tests failed${NC}"
  echo "  HTML report: test-results/html/index.html"
fi

exit $RESULT
