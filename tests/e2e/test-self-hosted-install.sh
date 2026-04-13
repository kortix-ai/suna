#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix E2E Test — Self-Hosted Docker Install                               ║
# ║                                                                            ║
# ║  Tests the complete get-kortix.sh flow from clean install to working        ║
# ║  dashboard. Run with: bash tests/e2e/test-self-hosted-install.sh           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

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
INSTALL_DIR="$HOME/.kortix"
OWNER_EMAIL="test@kortix.ai"
OWNER_PASSWORD="testpass123"
FRONTEND_URL="http://localhost:13737"
API_URL="http://localhost:13738"
SUPABASE_URL="http://localhost:13740"

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
docker ps -a --format '{{.Names}}' | grep -E '^(kortix-|supabase_)' | xargs -r docker rm -f 2>/dev/null || true

info "Removing existing Kortix installation..."
rm -rf "$INSTALL_DIR"

info "Freeing Kortix ports..."
for port in 13737 13738 13740 13741; do
    lsof -t -i:$port 2>/dev/null | xargs -r kill -9 2>/dev/null || true
done

pass "Cleanup complete"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 2: Run get-kortix.sh Installer"
# ═══════════════════════════════════════════════════════════════════════════════

info "Running installer with automated inputs..."
cd /Users/markokraemer/Projects/heyagi/computer

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

# Check if .credentials file was created
if [ -f "$INSTALL_DIR/.credentials" ]; then
    pass "Credentials file created"
else
    fail "Credentials file not found"
    exit 1
fi

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 3: Verify Containers"
# ═══════════════════════════════════════════════════════════════════════════════

sleep 5

run_test "Frontend container running" \
    "docker ps | grep -q 'kortix-frontend-1'"

run_test "API container running" \
    "docker ps | grep -q 'kortix-kortix-api-1'"

run_test "Sandbox container running" \
    "docker ps | grep -q 'kortix-sandbox'"

run_test "Supabase Kong running" \
    "docker ps | grep -q 'kortix-supabase-kong-1'"

run_test "Supabase Auth running" \
    "docker ps | grep -q 'kortix-supabase-auth-1'"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 4: Verify Services Health"
# ═══════════════════════════════════════════════════════════════════════════════

info "Waiting for services to be healthy..."
sleep 10

run_test "Frontend responds on port 13737" \
    "curl -sf $FRONTEND_URL/auth -o /dev/null"

run_test "API responds on port 13738" \
    "curl -sf $API_URL/v1/health -o /dev/null"

ANON_KEY=$(grep -m1 '^SUPABASE_ANON_KEY=' "$INSTALL_DIR/.env" | cut -d= -f2- || true)

run_test "Supabase Kong responds on port 13740" \
    "curl -sf $SUPABASE_URL/auth/v1/health -H \"apikey: $ANON_KEY\" -o /dev/null"

run_test "Sandbox responds on port 14000" \
    "curl -sf http://localhost:14000/kortix/health -o /dev/null"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 5: Test Authentication Flow"
# ═══════════════════════════════════════════════════════════════════════════════

info "Testing authentication API..."

# Get anon key from .env
ANON_KEY=$(grep -m1 '^SUPABASE_ANON_KEY=' "$INSTALL_DIR/.env" | cut -d= -f2-)

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

run_test "/dashboard accessible with auth" \
    "curl -sf '$FRONTEND_URL/dashboard' -H 'Cookie: sb-kortix-auth-token.0=$COOKIE_VALUE' -o /dev/null"

run_test "/onboarding accessible with auth" \
    "curl -sf '$FRONTEND_URL/onboarding' -H 'Cookie: sb-kortix-auth-token.0=$COOKIE_VALUE' -o /dev/null"

run_test "/dashboard returns dashboard content" \
    "curl -sf '$FRONTEND_URL/dashboard' -H 'Cookie: sb-kortix-auth-token.0=$COOKIE_VALUE' | grep -q 'Kortix'"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 7: Test Onboarding Flow"
# ═══════════════════════════════════════════════════════════════════════════════

info "Testing onboarding endpoints..."

# Test setup-status
run_test "Setup status endpoint works" \
    "curl -sf '$API_URL/v1/setup/setup-status' -H 'Authorization: Bearer $ACCESS_TOKEN' -o /dev/null"

# Test install-status
run_test "Install status endpoint works" \
    "curl -sf '$API_URL/v1/setup/install-status' -o /dev/null"

# Test sandbox status
run_test "Sandbox status endpoint works" \
    "curl -sf '$API_URL/v1/platform/init/local/status' -H 'Authorization: Bearer $ACCESS_TOKEN' -o /dev/null"

# ═══════════════════════════════════════════════════════════════════════════════
section "STEP 8: Verify Frontend Configuration"
# ═══════════════════════════════════════════════════════════════════════════════

info "Checking frontend bundle configuration..."

# Check that frontend has correct Supabase URL
docker exec kortix-frontend-1 sh -c 'grep -q "localhost:13740" /app/apps/web/.next/static/chunks/*.js' && \
    pass "Frontend has correct Supabase URL" || \
    fail "Frontend missing correct Supabase URL"

# Check that frontend doesn't have dev URLs
docker exec kortix-frontend-1 sh -c 'grep -q "127.0.0.1:54321" /app/apps/web/.next/static/chunks/*.js 2>/dev/null' && \
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
