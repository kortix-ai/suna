#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Test Suite: get-kortix.sh (unified installer)                             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/scripts/get-kortix.sh"

PASS=0; FAIL=0; TOTAL=0

pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); printf "\033[0;32m  ✓ %s\033[0m\n" "$1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); printf "\033[0;31m  ✗ %s\033[0m\n" "$1"; }

echo ""
echo "  Testing get-kortix.sh structure"
echo "  ════════════════════════════════"
echo ""

# ── Core structure ──

if [ -f "$SCRIPT" ]; then
  pass "get-kortix.sh exists"
else
  fail "get-kortix.sh exists"
fi

if grep -q 'banner()' "$SCRIPT"; then
  pass "has banner function"
else
  fail "has banner function"
fi

if grep -q 'preflight()' "$SCRIPT"; then
  pass "has preflight function"
else
  fail "has preflight function"
fi

if grep -q 'command -v docker' "$SCRIPT"; then
  pass "checks for Docker"
else
  fail "checks for Docker"
fi

if grep -q 'docker compose version' "$SCRIPT"; then
  pass "checks Docker Compose v2"
else
  fail "checks Docker Compose v2"
fi

if ! grep -q 'command -v git' "$SCRIPT"; then
  pass "does not require Git"
else
  fail "does not require Git"
fi

# ── Mode selection ──

if grep -q 'prompt_mode()' "$SCRIPT"; then
  pass "has mode selection (local/VPS)"
else
  fail "has mode selection (local/VPS)"
fi

if grep -q 'DEPLOY_MODE.*local\|DEPLOY_MODE.*vps' "$SCRIPT"; then
  pass "supports local and VPS deploy modes"
else
  fail "supports local and VPS deploy modes"
fi

if grep -q -- '--local' "$SCRIPT" && grep -q 'KORTIX_LOCAL_IMAGES' "$SCRIPT"; then
  pass "supports local installer image mode"
else
  fail "supports local installer image mode"
fi

if grep -q -- '--build-local' "$SCRIPT" && grep -q 'build-local-images.sh' "$SCRIPT"; then
  pass "supports rebuilding local images from source"
else
  fail "supports rebuilding local images from source"
fi

# ── Compose generation ──

if grep -q 'write_compose()' "$SCRIPT"; then
  pass "has compose generation function"
else
  fail "has compose generation function"
fi

if grep -q 'docker-compose.yml' "$SCRIPT"; then
  pass "writes docker-compose.yml"
else
  fail "writes docker-compose.yml"
fi

# ── PostgreSQL ──

if grep -q 'POSTGRES_IMAGE\|kortix/postgres' "$SCRIPT"; then
  pass "references postgres image"
else
  fail "references postgres image"
fi

if grep -q 'pg_cron\|pg_net' "$SCRIPT"; then
  pass "compose includes pg_cron and pg_net"
else
  fail "compose includes pg_cron and pg_net"
fi

if grep -q 'DATABASE_URL.*postgres' "$SCRIPT"; then
  pass "compose sets DATABASE_URL for kortix-api"
else
  fail "compose sets DATABASE_URL for kortix-api"
fi

if grep -q 'supabase-db-data' "$SCRIPT"; then
  pass "compose has persistent database volume"
else
  fail "compose has persistent database volume"
fi

# ── VPS features ──

if grep -q 'write_caddyfile()' "$SCRIPT"; then
  pass "has Caddyfile generation (VPS)"
else
  fail "has Caddyfile generation (VPS)"
fi

if grep -q 'caddy.*alpine\|caddy:2' "$SCRIPT"; then
  pass "uses Caddy for reverse proxy (VPS)"
else
  fail "uses Caddy for reverse proxy (VPS)"
fi

if grep -q 'basic_auth' "$SCRIPT"; then
  pass "supports basic auth (VPS)"
else
  fail "supports basic auth (VPS)"
fi

if grep -q 'prompt_domain()' "$SCRIPT"; then
  pass "has domain setup prompt (VPS)"
else
  fail "has domain setup prompt (VPS)"
fi

if grep -q 'tls internal' "$SCRIPT"; then
  pass "supports IP-only mode with self-signed TLS"
else
  fail "supports IP-only mode with self-signed TLS"
fi

# ── Security features ──

if grep -q 'generate_secrets()' "$SCRIPT"; then
  pass "has secret generation function"
else
  fail "has secret generation function"
fi

if grep -q 'API_KEY_SECRET' "$SCRIPT" && grep -q 'INTERNAL_SERVICE_KEY' "$SCRIPT"; then
  pass "generates service secrets for local install"
else
  fail "generates service secrets for local install"
fi

if grep -q 'INTERNAL_SERVICE_KEY' "$SCRIPT"; then
  pass "generates INTERNAL_SERVICE_KEY for service auth"
else
  fail "generates INTERNAL_SERVICE_KEY for service auth"
fi

if grep -q 'generate_password()' "$SCRIPT"; then
  pass "has password generation function"
else
  fail "has password generation function"
fi

if grep -q 'chmod 600.*\.env\|chmod 600.*credentials' "$SCRIPT"; then
  pass "sets secure permissions on secrets (600)"
else
  fail "sets secure permissions on secrets (600)"
fi

if grep -q 'setup_firewall()' "$SCRIPT"; then
  pass "has firewall setup function"
else
  fail "has firewall setup function"
fi

if grep -q 'ufw.*allow.*22\|ufw.*allow.*80\|ufw.*allow.*443' "$SCRIPT"; then
  pass "firewall allows SSH, HTTP, HTTPS only"
else
  fail "firewall allows SSH, HTTP, HTTPS only"
fi

# ── VPS compose security ──

if grep -q 'expose:' "$SCRIPT"; then
  pass "VPS compose uses 'expose' (internal-only ports)"
else
  fail "VPS compose uses 'expose' (internal-only ports)"
fi

if grep -q 'CORS_ALLOWED_ORIGINS' "$SCRIPT"; then
  pass "VPS compose restricts CORS origins"
else
  fail "VPS compose restricts CORS origins"
fi

if grep -q 'PUBLIC_URL=' "$SCRIPT" && grep -q 'FRONTEND_URL=' "$SCRIPT"; then
  pass "VPS compose wires public URL into services"
else
  fail "VPS compose wires public URL into services"
fi

# ── CLI features ──

if grep -q 'write_cli()' "$SCRIPT"; then
  pass "writes CLI helper"
else
  fail "writes CLI helper"
fi

for cmd in start stop restart logs status update setup; do
  if grep -q "${cmd})" "$SCRIPT"; then
    pass "CLI has '${cmd}' command"
  else
    fail "CLI has '${cmd}' command"
  fi
done

if grep -q 'credentials)' "$SCRIPT"; then
  pass "CLI has 'credentials' command"
else
  fail "CLI has 'credentials' command"
fi

# ── Compatibility ──

if ! grep -q 'declare -A' "$SCRIPT"; then
  pass "no declare -A (bash 3.x compatible)"
else
  fail "no declare -A (bash 3.x compatible)"
fi

if ! grep -q 'git clone\|git pull' "$SCRIPT"; then
  pass "no git clone/pull (Docker-only)"
else
  fail "no git clone/pull (Docker-only)"
fi

if grep -q 'kortix/kortix-frontend' "$SCRIPT" && grep -q 'kortix/kortix-api' "$SCRIPT"; then
  pass "uses pre-built Docker images"
else
  fail "uses pre-built Docker images"
fi

# ── Installer resilience (issue #3086) ──

if grep -q 'KORTIX_PULL_RETRIES' "$SCRIPT"; then
  pass "pull retry count is configurable (KORTIX_PULL_RETRIES)"
else
  fail "pull retry count is configurable (KORTIX_PULL_RETRIES)"
fi

if grep -q 'KORTIX_PULL_RETRY_DELAY' "$SCRIPT"; then
  pass "initial pull retry delay is configurable (KORTIX_PULL_RETRY_DELAY)"
else
  fail "initial pull retry delay is configurable (KORTIX_PULL_RETRY_DELAY)"
fi

if grep -q 'manifest unknown\|repository does not exist\|pull access denied' "$SCRIPT"; then
  pass "pull retry skips terminal registry errors"
else
  fail "pull retry skips terminal registry errors"
fi

if grep -qE 'docker compose up -d[[:space:]]*>"\$compose_log"' "$SCRIPT"; then
  pass "installer captures compose up output for diagnostics"
else
  fail "installer captures compose up output for diagnostics"
fi

# Behavioral test: stub a fake `docker` binary on PATH and exercise the
# retry helper extracted from the installer.
TMP_TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_TEST_DIR"' EXIT

mkdir -p "$TMP_TEST_DIR/bin"
cat > "$TMP_TEST_DIR/bin/docker" << 'FAKEDOCKER'
#!/usr/bin/env bash
# Fake docker binary used to exercise pull retry semantics in tests.
# Behavior is driven by env vars set by the test harness.
set -u
mode="${FAKE_DOCKER_MODE:-fail-then-succeed}"
state_file="${FAKE_DOCKER_STATE:-/tmp/_kortix_fake_docker_state}"
[ "${1:-}" = "pull" ] || { echo "fake docker only supports pull" >&2; exit 64; }

attempts=0
[ -f "$state_file" ] && attempts=$(cat "$state_file")
attempts=$((attempts + 1))
echo "$attempts" > "$state_file"

case "$mode" in
  always-succeed) echo "ok"; exit 0 ;;
  fail-then-succeed)
    if [ "$attempts" -ge 3 ]; then echo "ok"; exit 0; fi
    echo "dial tcp: lookup auth.docker.io on 127.0.0.53:53: i/o timeout" >&2
    exit 1
    ;;
  always-transient)
    echo "dial tcp: lookup registry.docker.io: i/o timeout" >&2
    exit 1
    ;;
  manifest-unknown)
    echo "Error response from daemon: manifest unknown" >&2
    exit 1
    ;;
  *)
    echo "fake docker: unknown mode $mode" >&2
    exit 99
    ;;
esac
FAKEDOCKER
chmod +x "$TMP_TEST_DIR/bin/docker"

# Extract just the `pull_images_parallel` function from the installer
# so we can exercise it without running the rest of the script.
cat > "$TMP_TEST_DIR/runner.sh" << 'RUNNER'
#!/usr/bin/env bash
set -euo pipefail
KORTIX_PULL_PARALLELISM="${KORTIX_PULL_PARALLELISM:-2}"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
error() { printf "    %s%s%s\n" "$RED" "$*" "$NC" >&2; }
warn()  { printf "    %s%s%s\n" "$YELLOW" "$*" "$NC"; }
SCRIPT="$1"; shift
awk '/^pull_images_parallel\(\) \{/{flag=1} flag{print} flag && /^\}$/{flag=0; exit}' "$SCRIPT" > /tmp/_pip.sh
# shellcheck disable=SC1091
source /tmp/_pip.sh
pull_images_parallel "$@"
RUNNER
chmod +x "$TMP_TEST_DIR/runner.sh"

run_pull_test() {
  local label="$1" mode="$2" expected_exit="$3" extra_env="$4"
  shift 4
  rm -f "$TMP_TEST_DIR/state"
  local actual_exit=0
  env -i PATH="$TMP_TEST_DIR/bin:/usr/bin:/bin" \
    HOME="$HOME" \
    FAKE_DOCKER_MODE="$mode" \
    FAKE_DOCKER_STATE="$TMP_TEST_DIR/state" \
    $extra_env \
    bash "$TMP_TEST_DIR/runner.sh" "$SCRIPT" "$@" >/dev/null 2>&1 \
    || actual_exit=$?
  if [ "$actual_exit" = "$expected_exit" ]; then
    pass "$label"
  else
    fail "$label (expected exit $expected_exit, got $actual_exit)"
  fi
}

run_pull_test "pull_images_parallel succeeds when docker pull works first try" \
  always-succeed 0 "" kortix/api:test
run_pull_test "pull_images_parallel retries transient errors and eventually succeeds" \
  fail-then-succeed 0 "KORTIX_PULL_RETRIES=4 KORTIX_PULL_RETRY_DELAY=1" kortix/api:test
run_pull_test "pull_images_parallel exits non-zero after exhausting retries on transient errors" \
  always-transient 1 "KORTIX_PULL_RETRIES=2 KORTIX_PULL_RETRY_DELAY=1" kortix/api:test
run_pull_test "pull_images_parallel fails fast on manifest-unknown without retrying" \
  manifest-unknown 1 "KORTIX_PULL_RETRIES=5 KORTIX_PULL_RETRY_DELAY=1" kortix/api:test

# manifest-unknown should make exactly 1 attempt (no wasted retry budget).
attempts=$(cat "$TMP_TEST_DIR/state" 2>/dev/null || echo 0)
if [ "$attempts" = "1" ]; then
  pass "manifest-unknown short-circuits at exactly 1 attempt"
else
  fail "manifest-unknown short-circuits at exactly 1 attempt (got $attempts)"
fi

# ── Old scripts deleted ──

if [ ! -f "$ROOT_DIR/scripts/install.sh" ]; then
  pass "install.sh deleted (unified into get-kortix.sh)"
else
  fail "install.sh deleted (unified into get-kortix.sh)"
fi

if [ ! -f "$ROOT_DIR/scripts/kortix.sh" ]; then
  pass "kortix.sh deleted (unified into get-kortix.sh)"
else
  fail "kortix.sh deleted (unified into get-kortix.sh)"
fi

# ── Summary ──
echo ""
echo "  ────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  printf "\033[0;32m  All %d tests passed\033[0m\n" "$TOTAL"
else
  printf "\033[0;31m  %d/%d tests failed\033[0m\n" "$FAIL" "$TOTAL"
fi
echo ""

exit "$FAIL"
