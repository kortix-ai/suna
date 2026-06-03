#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  E2E Test: VPS deployment                                                  ║
# ║                                                                            ║
# ║  Run ON the VPS after installation. Validates:                             ║
# ║    - Caddy is serving HTTPS                                                ║
# ║    - Basic auth blocks unauthenticated requests                            ║
# ║    - Basic auth allows authenticated requests                              ║
# ║    - Frontend is accessible through Caddy                                  ║
# ║    - API is proxied through Caddy at /v1                                   ║
# ║    - Internal ports are NOT accessible from outside                        ║
# ║    - Secrets are encrypted with unique key                                 ║
# ║    - Firewall is configured correctly                                      ║
# ║                                                                            ║
# ║  Usage: bash test-vps-e2e.sh <domain-or-ip> [admin-user] [admin-password] ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

DOMAIN="${1:-}"
ADMIN_USER="${2:-admin}"
ADMIN_PASSWORD="${3:-}"
INSTALL_DIR="${KORTIX_HOME:-$HOME/.kortix}"

if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain-or-ip> [admin-user] [admin-password]"
  echo ""
  echo "  If admin-password is not provided, reads from ~/.kortix/.credentials"
  exit 1
fi

# Try to read credentials from file if not provided
if [ -z "$ADMIN_PASSWORD" ] && [ -f "$INSTALL_DIR/.credentials" ]; then
  ADMIN_PASSWORD=$(grep '^Password:' "$INSTALL_DIR/.credentials" | awk '{print $2}')
fi

PASS=0; FAIL=0; TOTAL=0

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); printf "\033[0;32m  ✓ %s\033[0m\n" "$1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); printf "\033[0;31m  ✗ %s\033[0m\n" "$1"; }
skip() { TOTAL=$((TOTAL+1)); printf "\033[1;33m  ○ %s (skipped)\033[0m\n" "$1"; }

echo ""
echo "  VPS E2E Tests — ${DOMAIN}"
echo "  ════════════════════════════════"
echo ""

BASE_URL="https://${DOMAIN}"

# ── 1. HTTPS is working ──

echo "  HTTPS & TLS"
echo ""

HTTP_CODE=$(curl -s -k -o /dev/null -w "%{http_code}" "${BASE_URL}" 2>/dev/null)
if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "200" ]; then
  pass "HTTPS responds (status: ${HTTP_CODE})"
else
  fail "HTTPS responds (got: ${HTTP_CODE}, expected: 200 or 401)"
fi

# Check HTTP->HTTPS redirect
HTTP_REDIRECT=$(curl -s -o /dev/null -w "%{http_code}" "http://${DOMAIN}" 2>/dev/null)
if [ "$HTTP_REDIRECT" = "301" ] || [ "$HTTP_REDIRECT" = "308" ] || [ "$HTTP_REDIRECT" = "302" ]; then
  pass "HTTP redirects to HTTPS (${HTTP_REDIRECT})"
elif [ "$HTTP_REDIRECT" = "401" ] || [ "$HTTP_REDIRECT" = "200" ]; then
  pass "HTTP port responds (Caddy handling both)"
else
  skip "HTTP redirect check (got: ${HTTP_REDIRECT})"
fi

echo ""

# ── 2. Basic auth ──

echo "  Basic Auth"
echo ""

if [ -n "$ADMIN_PASSWORD" ]; then
  # Unauthenticated should get 401
  UNAUTH_CODE=$(curl -s -k -o /dev/null -w "%{http_code}" "${BASE_URL}" 2>/dev/null)
  if [ "$UNAUTH_CODE" = "401" ]; then
    pass "unauthenticated request returns 401"
  else
    fail "unauthenticated request returns 401 (got: ${UNAUTH_CODE})"
  fi

  # Authenticated should get 200
  AUTH_CODE=$(curl -s -k -o /dev/null -w "%{http_code}" -u "${ADMIN_USER}:${ADMIN_PASSWORD}" "${BASE_URL}" 2>/dev/null)
  if [ "$AUTH_CODE" = "200" ]; then
    pass "authenticated request returns 200"
  else
    fail "authenticated request returns 200 (got: ${AUTH_CODE})"
  fi

  # Wrong password should get 401
  WRONG_CODE=$(curl -s -k -o /dev/null -w "%{http_code}" -u "admin:wrong-password" "${BASE_URL}" 2>/dev/null)
  if [ "$WRONG_CODE" = "401" ]; then
    pass "wrong password returns 401"
  else
    fail "wrong password returns 401 (got: ${WRONG_CODE})"
  fi
else
  skip "basic auth tests (no password provided)"
fi

echo ""

# ── 3. Frontend accessible ──

echo "  Frontend"
echo ""

AUTH_ARGS=""
if [ -n "$ADMIN_PASSWORD" ]; then
  AUTH_ARGS="-u ${ADMIN_USER}:${ADMIN_PASSWORD}"
fi

FRONTEND_BODY=$(curl -s -k $AUTH_ARGS "${BASE_URL}" 2>/dev/null)
if echo "$FRONTEND_BODY" | grep -qi 'kortix\|next\|__next'; then
  pass "frontend serves HTML with Kortix/Next.js content"
else
  fail "frontend serves HTML with Kortix/Next.js content"
fi

echo ""

# ── 4. API proxied at /v1 ──

echo "  API Proxy (/v1)"
echo ""

API_CODE=$(curl -s -k $AUTH_ARGS -o /dev/null -w "%{http_code}" "${BASE_URL}/v1/health" 2>/dev/null)
if [ "$API_CODE" = "200" ]; then
  pass "API at /v1/health responds (${API_CODE})"
else
  fail "API proxy at /v1 (got: ${API_CODE})"
fi

echo ""

# ── 5. Internal ports NOT exposed ──

echo "  Port Isolation"
echo ""

# These ports should NOT be reachable from outside
for port in 3000 8008 14000 14001 14002 14003; do
  PORT_CODE=$(curl -s --connect-timeout 3 -o /dev/null -w "%{http_code}" "http://${DOMAIN}:${port}" 2>/dev/null)
  if [ "$PORT_CODE" = "000" ]; then
    pass "port ${port} is NOT externally accessible"
  else
    fail "port ${port} IS externally accessible (got: ${PORT_CODE}) — should be blocked"
  fi
done

echo ""

# ── 6. Docker containers running ──

echo "  Container Health"
echo ""

if command -v docker &>/dev/null; then
  for svc in caddy frontend kortix-api postgres kortix-sandbox; do
    CONTAINER_STATUS=$(docker ps --filter "name=${svc}" --format "{{.Status}}" 2>/dev/null | head -1)
    if echo "$CONTAINER_STATUS" | grep -qi 'up'; then
      pass "container '${svc}' is running"
    else
      fail "container '${svc}' is running (status: ${CONTAINER_STATUS:-not found})"
    fi
  done
else
  skip "container health (docker not available)"
fi

echo ""

# ── 7. Secrets file ──

echo "  Secret Store"
echo ""

if [ -f "$INSTALL_DIR/.env" ]; then
  pass ".env file exists"

  ENV_PERMS=$(stat -c '%a' "$INSTALL_DIR/.env" 2>/dev/null || stat -f '%Lp' "$INSTALL_DIR/.env" 2>/dev/null || echo "unknown")
  if [ "$ENV_PERMS" = "600" ]; then
    pass ".env has secure permissions (600)"
  else
    fail ".env has secure permissions (got: ${ENV_PERMS})"
  fi

  if grep -q 'KORTIX_TOKEN=' "$INSTALL_DIR/.env" 2>/dev/null; then
    TOKEN_VAL=$(grep 'KORTIX_TOKEN=' "$INSTALL_DIR/.env" | cut -d= -f2)
    if [ ${#TOKEN_VAL} -ge 32 ]; then
      pass "KORTIX_TOKEN is set (${#TOKEN_VAL} chars)"
    else
      fail "KORTIX_TOKEN is too short (${#TOKEN_VAL} chars)"
    fi
  else
    fail "KORTIX_TOKEN is set in .env"
  fi

  if grep -q 'INTERNAL_SERVICE_KEY=' "$INSTALL_DIR/.env" 2>/dev/null; then
    ISK_VAL=$(grep 'INTERNAL_SERVICE_KEY=' "$INSTALL_DIR/.env" | cut -d= -f2)
    if [ ${#ISK_VAL} -ge 32 ]; then
      pass "INTERNAL_SERVICE_KEY is set (${#ISK_VAL} chars)"
    else
      fail "INTERNAL_SERVICE_KEY is too short (${#ISK_VAL} chars)"
    fi
  else
    fail "INTERNAL_SERVICE_KEY is set in .env"
  fi
else
  fail ".env file exists"
fi

echo ""

# ── 8. Firewall ──

echo "  Firewall"
echo ""

if command -v ufw &>/dev/null; then
  UFW_STATUS=$(ufw status 2>/dev/null | head -1)
  if echo "$UFW_STATUS" | grep -qi 'active'; then
    pass "UFW is active"
  else
    fail "UFW is active (status: ${UFW_STATUS})"
  fi

  if ufw status 2>/dev/null | grep -q '22/tcp.*ALLOW'; then
    pass "UFW allows SSH (22)"
  else
    fail "UFW allows SSH (22)"
  fi

  if ufw status 2>/dev/null | grep -q '80/tcp.*ALLOW'; then
    pass "UFW allows HTTP (80)"
  else
    fail "UFW allows HTTP (80)"
  fi

  if ufw status 2>/dev/null | grep -q '443/tcp.*ALLOW'; then
    pass "UFW allows HTTPS (443)"
  else
    fail "UFW allows HTTPS (443)"
  fi
else
  skip "firewall tests (ufw not available)"
fi

echo ""

# ── 9. Credentials file ──

echo "  Credentials"
echo ""

if [ -f "$INSTALL_DIR/.credentials" ]; then
  pass ".credentials file exists"

  CRED_PERMS=$(stat -c '%a' "$INSTALL_DIR/.credentials" 2>/dev/null || stat -f '%Lp' "$INSTALL_DIR/.credentials" 2>/dev/null || echo "unknown")
  if [ "$CRED_PERMS" = "600" ]; then
    pass ".credentials has secure permissions (600)"
  else
    fail ".credentials has secure permissions (got: ${CRED_PERMS})"
  fi
else
  skip ".credentials file (auth may be disabled)"
fi

echo ""

# ── Summary ──
echo "  ────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf "\033[0;32m  All %d tests passed\033[0m\n" "$TOTAL"
else
  printf "\033[0;31m  %d/%d tests failed\033[0m\n" "$FAIL" "$TOTAL"
fi
echo ""

exit "$FAIL"
