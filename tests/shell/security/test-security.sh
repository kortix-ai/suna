#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Test Suite: Security features                                             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/get-kortix.sh"
MASTER_INDEX="$ROOT_DIR/core/kortix-master/src/index.ts"
MASTER_CONFIG="$ROOT_DIR/core/kortix-master/src/config.ts"

PASS=0; FAIL=0; TOTAL=0

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); printf "\033[0;32m  ✓ %s\033[0m\n" "$1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); printf "\033[0;31m  ✗ %s\033[0m\n" "$1"; }

echo ""
echo "  Testing security features"
echo "  ════════════════════════════════"
echo ""

# ── Sandbox: Auth ──

echo "  Sandbox auth"
echo ""

if grep -q 'verifyServiceKey' "$MASTER_INDEX"; then
  pass "master uses verifyServiceKey for auth"
else
  fail "master uses verifyServiceKey for auth"
fi

if grep -q 'INTERNAL_SERVICE_KEY' "$MASTER_CONFIG"; then
  pass "config exports INTERNAL_SERVICE_KEY"
else
  fail "config exports INTERNAL_SERVICE_KEY"
fi

if grep -q '401' "$MASTER_INDEX"; then
  pass "master returns 401 on auth failure"
else
  fail "master returns 401 on auth failure"
fi

echo ""

# ── Sandbox: CORS restriction ──

echo "  Sandbox CORS restriction"
echo ""

if grep -q 'CORS_ALLOWED_ORIGINS' "$MASTER_INDEX"; then
  pass "master index reads CORS_ALLOWED_ORIGINS"
else
  fail "master index reads CORS_ALLOWED_ORIGINS"
fi

if grep -q 'origin:.*corsOrigins\|corsOrigins.*origin' "$MASTER_INDEX"; then
  pass "master applies origin restriction when set"
else
  fail "master applies origin restriction when set"
fi

echo ""

# ── Frontend Dockerfile ──

echo "  Frontend Dockerfile"
echo ""

FRONTEND_DOCKERFILE="$ROOT_DIR/apps/web/Dockerfile"

if grep -q 'standalone' "$FRONTEND_DOCKERFILE"; then
  pass "Dockerfile copies standalone output"
else
  fail "Dockerfile copies standalone output"
fi

if grep -q 'USER nextjs' "$FRONTEND_DOCKERFILE"; then
  pass "Dockerfile runs as non-root user (nextjs)"
else
  fail "Dockerfile runs as non-root user (nextjs)"
fi

if grep -q 'docker-entrypoint.sh' "$FRONTEND_DOCKERFILE"; then
  pass "Dockerfile includes docker-entrypoint.sh"
else
  fail "Dockerfile includes docker-entrypoint.sh"
fi

if grep -q 'ENTRYPOINT' "$FRONTEND_DOCKERFILE"; then
  pass "Dockerfile has ENTRYPOINT"
else
  fail "Dockerfile has ENTRYPOINT"
fi

echo ""

# ── Installer: Compose security ──

echo "  Compose template"
echo ""

# The unified write_compose() handles both modes
COMPOSE_FN=$(sed -n '/write_compose()/,/^}/p' "$SCRIPT")

if echo "$COMPOSE_FN" | grep -q 'expose:'; then
  pass "VPS compose uses 'expose' (internal-only ports)"
else
  fail "VPS compose uses 'expose' (internal-only ports)"
fi

if echo "$COMPOSE_FN" | grep -q 'INTERNAL_SERVICE_KEY'; then
  pass "compose passes INTERNAL_SERVICE_KEY to services"
else
  fail "compose passes INTERNAL_SERVICE_KEY to services"
fi

if echo "$COMPOSE_FN" | grep -q 'CORS_ALLOWED_ORIGINS'; then
  pass "compose sets CORS_ALLOWED_ORIGINS"
else
  fail "compose sets CORS_ALLOWED_ORIGINS"
fi

if echo "$COMPOSE_FN" | grep -q '"13737:3000"'; then
  pass "local compose maps frontend to port 13737"
else
  fail "local compose maps frontend to port 13737"
fi

if echo "$COMPOSE_FN" | grep -q '"13738:8008"'; then
  pass "local compose maps API to port 13738"
else
  fail "local compose maps API to port 13738"
fi

echo ""

# ── Installer: Secret generation ──

echo "  Secret generation"
echo ""

if grep -q 'generate_token()' "$SCRIPT"; then
  pass "has token generation function"
else
  fail "has token generation function"
fi

if grep -q '/dev/urandom' "$SCRIPT"; then
  pass "uses /dev/urandom for randomness"
else
  fail "uses /dev/urandom for randomness"
fi

if grep -q 'generate_password()' "$SCRIPT"; then
  pass "has readable password generation"
else
  fail "has readable password generation"
fi

if grep -q 'chmod 600.*\.env\|chmod 600.*credentials' "$SCRIPT"; then
  pass "sets secure permissions on secrets (600)"
else
  fail "sets secure permissions on secrets (600)"
fi

echo ""

# ── API: Internal service key forwarding ──

echo "  API service key forwarding"
echo ""

API_SETUP="$ROOT_DIR/apps/api/src/setup/index.ts"

if grep -q 'INTERNAL_SERVICE_KEY' "$API_SETUP"; then
  pass "setup/index.ts injects INTERNAL_SERVICE_KEY"
else
  fail "setup/index.ts injects INTERNAL_SERVICE_KEY"
fi

if grep -q 'Authorization.*Bearer.*serviceKey' "$API_SETUP"; then
  pass "setup/index.ts sends Bearer token header"
else
  fail "setup/index.ts sends Bearer token header"
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
