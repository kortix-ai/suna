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
INSTALL_DIR="$HOME/.kortix"
INSTALL_LOG="$REPO_ROOT/test-results/install.log"

# ── Config ────────────────────────────────────────────────────────────────────
export E2E_OWNER_EMAIL="${E2E_OWNER_EMAIL:-test-e2e@kortix.ai}"
export E2E_OWNER_PASSWORD="${E2E_OWNER_PASSWORD:-e2e-testpass-123}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:13737}"
export E2E_API_URL="${E2E_API_URL:-http://localhost:13738/v1}"
export E2E_SUPABASE_URL="${E2E_SUPABASE_URL:-http://localhost:13740}"
export E2E_SANDBOX_HEALTH_URL="${E2E_SANDBOX_HEALTH_URL:-http://localhost:14000/kortix/health}"

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

  info "Stopping existing Kortix containers..."
  docker ps -a --format '{{.Names}}' | grep -E '^kortix-' | xargs -r docker rm -f 2>/dev/null || true

  info "Removing Docker volumes..."
  docker volume ls --format '{{.Name}}' | grep -E 'kortix' | xargs -r docker volume rm -f 2>/dev/null || true

  info "Removing Kortix installation dir..."
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

  if [ -f "$INSTALL_DIR/.credentials" ]; then
    pass "Installer completed, credentials written"
  else
    fail "Credentials file missing after install"
    exit 1
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4: Wait for services
# ═══════════════════════════════════════════════════════════════════════════════
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
  if [ -f "$HOME/.kortix/.env" ]; then
    anon_key=$(grep -m1 '^SUPABASE_ANON_KEY=' "$HOME/.kortix/.env" | cut -d= -f2- || true)
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

# Sandbox may take longer
wait_for_url "$E2E_SANDBOX_HEALTH_URL"            "Sandbox :14000"  90 || info "(sandbox health timeout — tests will retry)"

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
npx playwright test -c playwright.config.ts 2>&1

RESULT=$?

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
