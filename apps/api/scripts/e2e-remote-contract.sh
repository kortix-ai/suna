#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  Kortix API — Remote Black-Box Contract E2E                               ║
# ║                                                                          ║
# ║  Exercises the live HTTP surface of a deployed kortix-api over the wire  ║
# ║  (through nginx + Cloudflare for dev), asserting status codes + body     ║
# ║  invariants on every public and auth-gated route. Unlike the in-process ║
# ║  bun:test e2e files (which mock the DB and call app.request()), this     ║
# ║  hits a REAL base URL — so it catches infra issues (nginx 502s, CORS,    ║
# ║  TLS, routing) that in-process tests cannot.                             ║
# ║                                                                          ║
# ║  Usage:                                                                  ║
# ║    BASE_URL=https://dev-api.kortix.com bash e2e-remote-contract.sh       ║
# ║    BASE_URL=http://localhost:8008      bash e2e-remote-contract.sh       ║
# ║                                                                          ║
# ║  Env:                                                                    ║
# ║    BASE_URL    target API origin (no trailing slash, no /v1)            ║
# ║    ORIGIN      Origin header for CORS checks (default https://dev.kortix.com) ║
# ║    STRESS_N    keepalive stress request count (default 200)             ║
# ║    STRESS_C    stress concurrency (default 12)                          ║
# ║  Exit 0 iff every assertion passes.                                      ║
# ╚══════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

BASE_URL="${BASE_URL:-https://dev-api.kortix.com}"
BASE_URL="${BASE_URL%/}"
ORIGIN="${ORIGIN:-https://dev.kortix.com}"
STRESS_N="${STRESS_N:-200}"
STRESS_C="${STRESS_C:-12}"

G=$'\033[0;32m'; R=$'\033[0;31m'; Y=$'\033[1;33m'; B=$'\033[0;36m'; NC=$'\033[0m'
pass=0; fail=0; FAILED_NAMES=""

# assert_status NAME METHOD PATH EXPECTED_CODE [BODY_SUBSTRING]
assert_status() {
  local name="$1" method="$2" path="$3" want="$4" needle="${5:-}"
  local out code body
  out=$(curl -sS -m20 -X "$method" -H "Origin: $ORIGIN" -o /tmp/ec_body.$$ -w "%{http_code}" "$BASE_URL$path" 2>/tmp/ec_err.$$)
  code="$out"; body=$(tr -d '\0' < /tmp/ec_body.$$ 2>/dev/null | head -c 400)
  local okstatus=1 okbody=1
  [ "$code" = "$want" ] || okstatus=0
  if [ -n "$needle" ]; then case "$body" in *"$needle"*) :;; *) okbody=0;; esac; fi
  if [ "$okstatus" = 1 ] && [ "$okbody" = 1 ]; then
    pass=$((pass+1)); printf "  ${G}✓${NC} %-7s %-30s → %s\n" "$method" "$path" "$code"
  else
    fail=$((fail+1)); FAILED_NAMES="$FAILED_NAMES\n    - $name ($method $path)"
    printf "  ${R}✗${NC} %-7s %-30s → got %s want %s%s\n" "$method" "$path" "$code" "$want" \
      "$([ "$okbody" = 0 ] && echo " | body missing '$needle': ${body:0:80}")"
  fi
  rm -f /tmp/ec_body.$$ /tmp/ec_err.$$
}

echo "${B}━━ Kortix API remote contract e2e ━━${NC}"
echo "  target: $BASE_URL"
echo "  origin: $ORIGIN"
echo ""

echo "${B}[1] Public health + status${NC}"
assert_status "health"          GET /health                       200 '"status":"ok"'
assert_status "v1-health"       GET /v1/health                    200 '"service":"kortix-api"'
assert_status "system-status"   GET /v1/system/status             200 'maintenanceNotice'
assert_status "sandbox-version" GET /v1/platform/sandbox/version  200 '"version"'
assert_status "signup-status"   GET /v1/access/signup-status      200 'signupsEnabled'

echo ""
echo "${B}[2] Auth gating (must reject anonymous with 401, not 5xx)${NC}"
assert_status "accounts-401"    GET /v1/accounts                  401 'Authorization'
assert_status "projects-401"    GET /v1/projects                  401 'Authorization'
assert_status "billing-401"     GET /v1/billing/account-state     401 'Authorization'
assert_status "router-401"      GET /v1/router/models             401 'Authorization'

echo ""
echo "${B}[3] Routing correctness (404 for unknown, not 502)${NC}"
assert_status "unknown-404"     GET /v1/does-not-exist-xyz        404 'Not found'

echo ""
echo "${B}[4] CORS preflight${NC}"
# OPTIONS preflight should succeed (204) and echo the allowed origin
preflight=$(curl -sS -m20 -X OPTIONS -H "Origin: $ORIGIN" \
  -H "Access-Control-Request-Method: GET" \
  -D /tmp/ec_hdr.$$ -o /dev/null -w "%{http_code}" "$BASE_URL/v1/health" 2>/dev/null)
acao=$(grep -i "access-control-allow-origin" /tmp/ec_hdr.$$ 2>/dev/null | tr -d '\r' | head -1)
if { [ "$preflight" = "204" ] || [ "$preflight" = "200" ]; } && echo "$acao" | grep -qi "$ORIGIN"; then
  pass=$((pass+1)); printf "  ${G}✓${NC} OPTIONS /v1/health preflight → %s | %s\n" "$preflight" "$acao"
else
  fail=$((fail+1)); FAILED_NAMES="$FAILED_NAMES\n    - cors-preflight"
  printf "  ${R}✗${NC} OPTIONS preflight → %s | acao='%s'\n" "$preflight" "$acao"
fi
rm -f /tmp/ec_hdr.$$

echo ""
echo "${B}[5] No-502 stress (keepalive reuse, ${STRESS_N} reqs @ ${STRESS_C} concurrent)${NC}"
worker() {
  local n=$1 cfg; cfg=$(mktemp)
  for _ in $(seq 1 "$n"); do
    printf 'url = "%s/v1/health"\noutput = "/dev/null"\nwrite-out = "%%{http_code}\\n"\n' "$BASE_URL"
  done > "$cfg"
  curl -sS -m60 -K "$cfg" 2>/dev/null; rm -f "$cfg"
}
export -f worker; export BASE_URL
per=$(( STRESS_N / STRESS_C )); [ "$per" -lt 1 ] && per=1
codes=$(seq 1 "$STRESS_C" | xargs -P"$STRESS_C" -I{} bash -c "worker $per" 2>/dev/null)
total=$(echo "$codes" | grep -c .); non200=$(echo "$codes" | grep -vc "^200$")
if [ "$non200" = "0" ] && [ "$total" -gt 0 ]; then
  pass=$((pass+1)); printf "  ${G}✓${NC} %s/%s requests 200, zero 502/5xx\n" "$total" "$total"
else
  fail=$((fail+1)); FAILED_NAMES="$FAILED_NAMES\n    - stress-no-502 ($non200/$total non-200)"
  printf "  ${R}✗${NC} %s of %s requests non-200:\n%s\n" "$non200" "$total" "$(echo "$codes" | sort | uniq -c)"
fi

echo ""
echo "${B}━━ Summary ━━${NC}"
printf "  passed: ${G}%s${NC}   failed: ${R}%s${NC}\n" "$pass" "$fail"
if [ "$fail" -gt 0 ]; then printf "  ${R}FAILED:${NC}$FAILED_NAMES\n"; exit 1; fi
echo "  ${G}ALL CONTRACT CHECKS PASSED${NC}"
