#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix E2E Test — Self-Hosted Docker Install                               ║
# ║                                                                            ║
# ║  Tests the complete get-kortix.sh flow from clean install to working        ║
# ║  dashboard. Run with: bash tests/e2e/test-self-hosted-install.sh           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Colors
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'; BOLD=$'\033[1m'
NC=$'\033[0m'

info()    { echo "  ${BLUE}[TEST]${NC} $*"; }
pass()    { echo "  ${GREEN}[PASS]${NC} $*"; }
fail()    { echo "  ${RED}[FAIL]${NC} $*" >&2; }
section() { echo ""; echo "${BOLD}${CYAN}$1${NC}"; echo ""; }

# Config
TEST_DIR="$HOME/.kortix-e2e-test"
INSTALL_DIR="${KORTIX_E2E_INSTALL_DIR:-${KORTIX_HOME:-$TEST_DIR/install}}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$INSTALL_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/^[._-]*//; s/[^a-z0-9_-]//g')}"
[ -n "$COMPOSE_PROJECT_NAME" ] || COMPOSE_PROJECT_NAME="kortix-e2e"
SANDBOX_CONTAINER_NAME="${SANDBOX_CONTAINER_NAME:-${COMPOSE_PROJECT_NAME}-sandbox}"
SANDBOX_PORT_BASE="${SANDBOX_PORT_BASE:-15000}"
OWNER_EMAIL="${E2E_OWNER_EMAIL:-test@kortix.ai}"
OWNER_PASSWORD="${E2E_OWNER_PASSWORD:-testpass123}"
FRONTEND_URL="${E2E_BASE_URL:-http://localhost:13737}"
API_URL="${E2E_API_URL:-http://localhost:13738/v1}"
API_ORIGIN="${API_URL%/v1}"
SUPABASE_URL="${E2E_SUPABASE_URL:-http://localhost:13740}"
SANDBOX_HEALTH_URL="${E2E_SANDBOX_HEALTH_URL:-http://localhost:${SANDBOX_PORT_BASE}/kortix/health}"
PREVIEW_COOKIE_JAR="$(mktemp -t kortix-preview-cookie.XXXXXX)"
export KORTIX_HOME="$INSTALL_DIR"
export COMPOSE_PROJECT_NAME
export SANDBOX_CONTAINER_NAME
export SANDBOX_PORT_BASE
export E2E_ENV_FILE="${E2E_ENV_FILE:-$INSTALL_DIR/.env}"

cleanup() {
    rm -f "$PREVIEW_COOKIE_JAR"
}

trap cleanup EXIT

# Track results
TESTS_PASSED=0
TESTS_FAILED=0

run_test() {
    local name="$1"
    local cmd="$2"
    
    info "Testing: $name"
    if eval "$cmd" >/dev/null 2>&1; then
        pass "$name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        fail "$name"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 1: Pre-Flight Cleanup"
# ═══════════════════════════════════════════════════════════════════════════════

info "Stopping any existing Kortix containers..."
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

info "Removing existing Kortix installation..."
rm -rf "$INSTALL_DIR"

info "Freeing Kortix ports..."
for port in 13737 13738 13740 13741 "$SANDBOX_PORT_BASE"; do
    lsof -t -i:$port 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done

pass "Cleanup complete"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 2: Run get-kortix.sh Installer"
# ═══════════════════════════════════════════════════════════════════════════════

info "Running installer with automated inputs..."
cd "$REPO_ROOT"

# Run installer with all inputs provided via stdin
# 1 = local mode, 1 = Docker database, email, password, password, n = skip integrations
export KORTIX_OWNER_EMAIL="$OWNER_EMAIL"
export KORTIX_OWNER_PASSWORD="$OWNER_PASSWORD"

printf "1\n1\nn\n" | bash scripts/get-kortix.sh --local 2>&1 | tee /tmp/kortix-install.log | while read line; do
    if [[ "$line" == *"Kortix is running"* ]]; then
        pass "Installer completed successfully"
        break
    fi
done

# Check if stack config was created
if [ -f "$INSTALL_DIR/.env" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    pass "Stack config created"
else
    fail "Stack config not found"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 3: Verify Containers"
# ═══════════════════════════════════════════════════════════════════════════════

sleep 5

run_test "Frontend container running" \
    "docker ps | grep -q '${COMPOSE_PROJECT_NAME}-frontend-1'"

run_test "API container running" \
    "docker ps | grep -q '${COMPOSE_PROJECT_NAME}-kortix-api-1'"

run_test "API container has docker CLI" \
    "docker exec ${COMPOSE_PROJECT_NAME}-kortix-api-1 sh -lc 'command -v docker >/dev/null'"

run_test "Sandbox container running" \
    "docker ps | grep -q '$SANDBOX_CONTAINER_NAME'"

run_test "Supabase Kong running" \
    "docker ps | grep -q '${COMPOSE_PROJECT_NAME}-supabase-kong-1'"

run_test "Supabase Auth running" \
    "docker ps | grep -q '${COMPOSE_PROJECT_NAME}-supabase-auth-1'"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 4: Verify Services Health"
# ═══════════════════════════════════════════════════════════════════════════════

info "Waiting for services to be healthy..."
sleep 10

run_test "Frontend responds on port 13737" \
    "curl -sf $FRONTEND_URL/auth -o /dev/null"

run_test "API responds on port 13738" \
    "curl -sf $API_URL/health -o /dev/null"

ANON_KEY=$(grep -m1 '^SUPABASE_ANON_KEY=' "$INSTALL_DIR/.env" | cut -d= -f2- || true)

run_test "Supabase Kong responds on port 13740" \
    "curl -sf $SUPABASE_URL/auth/v1/health -H \"apikey: $ANON_KEY\" -o /dev/null"

info "Bootstrapping owner account..."
BOOTSTRAP_RESPONSE=$(curl -sS -X POST "$API_URL/setup/bootstrap-owner" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" 2>&1 || true)

if [ -n "$BOOTSTRAP_RESPONSE" ] && echo "$BOOTSTRAP_RESPONSE" | grep -q '"success":true'; then
    {
        printf 'Email: %s\n' "$OWNER_EMAIL"
        printf 'Password: %s\n' "$OWNER_PASSWORD"
    } > "$INSTALL_DIR/.credentials"
    chmod 600 "$INSTALL_DIR/.credentials"
    pass "Owner account ready"
elif curl -fsS "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" >/dev/null 2>&1; then
    pass "Owner account already usable"
else
    fail "Owner bootstrap failed"
    echo "Response: $BOOTSTRAP_RESPONSE"
    exit 1
fi

run_test "Sandbox responds on port $SANDBOX_PORT_BASE" \
    "curl -sf $SANDBOX_HEALTH_URL -o /dev/null"

run_test "API logs do not contain docker CLI errors" \
    "! docker logs ${COMPOSE_PROJECT_NAME}-kortix-api-1 2>&1 | grep -q '/bin/sh: 1: docker: not found'"

run_test "API logs do not contain sandbox auth sync fatal retries" \
    "! docker logs ${COMPOSE_PROJECT_NAME}-kortix-api-1 2>&1 | grep -q '\[LOCAL-PREVIEW\] Sandbox auth sync failed after 3 attempts, giving up'"

run_test "API logs do not hit network-mode fallback dead end" \
    "! docker logs ${COMPOSE_PROJECT_NAME}-kortix-api-1 2>&1 | grep -q '\[sandbox-health\] Cannot use docker exec fallback in network mode'"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 5: Test Authentication Flow"
# ═══════════════════════════════════════════════════════════════════════════════

info "Testing authentication API..."

# Get anon key from .env
ANON_KEY=$(grep -m1 '^SUPABASE_ANON_KEY=' "$INSTALL_DIR/.env" | cut -d= -f2-)
SANDBOX_NAME=$(grep -m1 '^SANDBOX_CONTAINER_NAME=' "$INSTALL_DIR/.env" | cut -d= -f2- || echo "kortix-hosted-sandbox")

# Test sign-in
SESSION_RESPONSE=$(curl -sf "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}" 2>&1)

if [ -n "$SESSION_RESPONSE" ] && echo "$SESSION_RESPONSE" | grep -q '"access_token"'; then
    pass "Authentication API working"
    ACCESS_TOKEN=$(echo "$SESSION_RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
else
    fail "Authentication API failed"
    echo "Response: $SESSION_RESPONSE"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 6: Test Protected Routes"
# ═══════════════════════════════════════════════════════════════════════════════

info "Testing protected routes with auth cookie..."

# Create auth cookie
COOKIE_VALUE=$(python3 -c "
import json, urllib.parse
session = json.loads('''$SESSION_RESPONSE''')
print(urllib.parse.quote(json.dumps(session, separators=(',', ':')), safe=''))
")

run_test "/projects accessible with auth" \
    "curl -sf '$FRONTEND_URL/projects' -H 'Cookie: sb-kortix-auth-token.0=$COOKIE_VALUE' -o /dev/null"

run_test "/accounts accessible with auth" \
    "curl -sf '$FRONTEND_URL/accounts' -H 'Cookie: sb-kortix-auth-token.0=$COOKIE_VALUE' -o /dev/null"

run_test "/projects returns product shell" \
    "curl -sf '$FRONTEND_URL/projects' -H 'Cookie: sb-kortix-auth-token.0=$COOKIE_VALUE' | grep -q 'Kortix'"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 7: Test Onboarding Flow"
# ═══════════════════════════════════════════════════════════════════════════════

info "Testing onboarding endpoints..."

# Test setup-status
run_test "Setup status endpoint works" \
    "curl -sf '$API_URL/setup/setup-status' -H 'Authorization: Bearer $ACCESS_TOKEN' -o /dev/null"

# Test install-status
run_test "Install status endpoint works" \
    "curl -sf '$API_URL/setup/install-status' -o /dev/null"

# Test sandbox status
run_test "Sandbox status endpoint works" \
    "curl -sf '$API_URL/platform/init/local/status' -H 'Authorization: Bearer $ACCESS_TOKEN' -o /dev/null"

run_test "Preview auth endpoint sets sandbox session cookie" \
    "curl -sf -X POST '$API_URL/p/auth' -H 'Authorization: Bearer $ACCESS_TOKEN' -c '$PREVIEW_COOKIE_JAR' -o /dev/null"

run_test "Sandbox preview proxy reaches authenticated internal endpoint" \
    "curl -sf '$API_URL/p/$SANDBOX_NAME/8000/global/health' -b '$PREVIEW_COOKIE_JAR' -o /dev/null"

run_test "Setup env save works through sandbox secret store" \
    "curl -sf '$API_URL/setup/env' -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'Content-Type: application/json' -d '{\"keys\":{\"TAVILY_API_KEY\":\"e2e-test-key\"}}' | grep -q '\"ok\":true'"

run_test "Setup env read shows saved key configured" \
    "curl -sf '$API_URL/setup/env' -H 'Authorization: Bearer $ACCESS_TOKEN' | python3 -c \"import json,sys; print(str(json.load(sys.stdin)['configured'].get('TAVILY_API_KEY', False)).lower())\" | grep -q '^true$'"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 8: Verify Frontend Configuration"
# ═══════════════════════════════════════════════════════════════════════════════

info "Checking frontend bundle configuration..."

# Check that frontend has correct Supabase URL
docker exec "${COMPOSE_PROJECT_NAME}-frontend-1" sh -c 'grep -q "localhost:13740" /app/apps/web/.next/static/chunks/*.js' && \
    pass "Frontend has correct Supabase URL" || \
    fail "Frontend missing correct Supabase URL"

# Check that frontend doesn't have dev URLs
docker exec "${COMPOSE_PROJECT_NAME}-frontend-1" sh -c 'grep -q "127.0.0.1:54321" /app/apps/web/.next/static/chunks/*.js 2>/dev/null' && \
    fail "Frontend still has dev Supabase URL" || \
    pass "Frontend doesn't have dev URLs"

# ═══════════════════════════════════════════════════════════════════════════════
section "TEST SUMMARY"
# ═══════════════════════════════════════════════════════════════════════════════

echo ""
echo "${BOLD}Results:${NC}"
echo "  ${GREEN}Passed:${NC} $TESTS_PASSED"
echo "  ${RED}Failed:${NC} $TESTS_FAILED"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo "${GREEN}${BOLD}✅ All tests passed!${NC}"
    echo ""
    echo "Kortix is fully operational at: ${CYAN}$FRONTEND_URL${NC}"
    echo "Login with: ${CYAN}$OWNER_EMAIL${NC} / ${CYAN}$OWNER_PASSWORD${NC}"
    exit 0
else
    echo "${RED}${BOLD}❌ Some tests failed${NC}"
    exit 1
fi
