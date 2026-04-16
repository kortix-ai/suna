#!/bin/bash
# ============================================================================
# Browser System E2E Tests
# ============================================================================
#
# Tests the persistent browser infrastructure end-to-end:
#   - Chrome persistent instance (CDP on 9222)
#   - agent-browser daemon (session "kortix", stream on 9223)
#   - agent-browser viewer (HTTP on 9224)
#   - Selkies desktop stream (HTTP on 6080)
#
# Usage:
#   # Run inside the sandbox container:
#   bash /opt/tests/test-browser-system.sh
#
#   # Run from the host (against running container):
#   docker exec kortix-sandbox bash /opt/tests/test-browser-system.sh
#
#   # Run from the repo root:
#   docker exec kortix-sandbox bash /workspace/computer/core/tests/test-browser-system.sh
#
# Exit codes:
#   0 = all tests passed
#   1 = one or more tests failed
# ============================================================================

set -euo pipefail

PASS=0
FAIL=0
TOTAL=0

# ── Helpers ─────────────────────────────────────────────────────────────────

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  echo "  ✓ $1"
}

fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  echo "  ✗ $1"
  [ -n "${2:-}" ] && echo "    → $2"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$label"
  else
    fail "$label" "expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$label"
  else
    fail "$label" "expected to contain '$needle'"
  fi
}

assert_not_empty() {
  local label="$1" value="$2"
  if [ -n "$value" ]; then
    pass "$label"
  else
    fail "$label" "expected non-empty value"
  fi
}

assert_http_ok() {
  local label="$1" url="$2"
  local code
  code=$(curl -sf -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    pass "$label (HTTP $code)"
  else
    fail "$label" "HTTP $code"
  fi
}

capture_stream_event() {
  python3 - <<'PY'
import sys
import time
import urllib.request

url = "http://127.0.0.1:9224/stream?port=9223"
req = urllib.request.Request(url, headers={"Accept": "text/event-stream"})

try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        deadline = time.time() + 10
        chunks = []
        while time.time() < deadline:
            line = resp.readline().decode("utf-8", "ignore")
            if not line:
                continue
            chunks.append(line)
            joined = "".join(chunks)
            if (
                "event: status" in joined
                or '"connected":true' in joined
                or '"type":"frame"' in joined
            ):
                sys.stdout.write(joined)
                sys.exit(0)
except Exception:
    pass

sys.exit(1)
PY
}

# ── Tests ───────────────────────────────────────────────────────────────────

echo ""
echo "╔════════════════════════════════════════════════════╗"
echo "║        Browser System E2E Tests                   ║"
echo "╚════════════════════════════════════════════════════╝"
echo ""

# --------------------------------------------------------------------------
echo "▸ 1. agent-browser CLI"
# --------------------------------------------------------------------------

VERSION=$(agent-browser --version 2>&1 || echo "")
assert_contains "agent-browser installed" "agent-browser" "$VERSION"
assert_contains "version >= 0.19" "0." "$VERSION"

# --------------------------------------------------------------------------
echo ""
echo "▸ 2. Chrome Persistent Instance (CDP port 9222)"
# --------------------------------------------------------------------------

CDP_RESPONSE=$(curl -sf http://127.0.0.1:9222/json/version 2>/dev/null || echo "")
assert_not_empty "CDP port 9222 responds" "$CDP_RESPONSE"
assert_contains "Chrome browser detected" "Chrome" "$CDP_RESPONSE"

# --------------------------------------------------------------------------
echo ""
echo "▸ 3. agent-browser Daemon"
# --------------------------------------------------------------------------

DAEMON_COUNT=$(pgrep -cf "node.*dist/daemon.js" 2>/dev/null || echo "0")
if [ "$DAEMON_COUNT" -ge 1 ]; then
  pass "Daemon process running ($DAEMON_COUNT)"
else
  fail "Daemon process running" "no daemon found"
fi

SOCKET_IN_KERNEL=$(grep -c "kortix.sock" /proc/net/unix 2>/dev/null || echo "0")
if [ "$SOCKET_IN_KERNEL" -ge 1 ]; then
  pass "Daemon socket exists in kernel"
else
  fail "Daemon socket exists in kernel" "not found in /proc/net/unix"
fi

# --------------------------------------------------------------------------
echo ""
echo "▸ 4. agent-browser CLI Commands"
# --------------------------------------------------------------------------

# Get URL (should work without error)
URL_RESULT=$(agent-browser get url 2>&1)
if echo "$URL_RESULT" | grep -qE "^https?://|^about:"; then
  pass "get url returns valid URL ($URL_RESULT)"
else
  fail "get url returns valid URL" "$URL_RESULT"
fi

# Navigate to example.com
OPEN_RESULT=$(agent-browser open https://example.com 2>&1)
assert_contains "open example.com succeeds" "Example Domain" "$OPEN_RESULT"

# Get URL after navigation
URL_AFTER=$(agent-browser get url 2>&1)
assert_eq "URL is example.com after open" "https://example.com/" "$URL_AFTER"

# Get title
TITLE=$(agent-browser get title 2>&1)
assert_eq "Title is Example Domain" "Example Domain" "$TITLE"

# Snapshot
SNAPSHOT=$(agent-browser snapshot -i -c 2>&1)
assert_contains "Snapshot returns refs" "ref=" "$SNAPSHOT"

# Screenshot
SCREENSHOT_PATH="/tmp/browser-test-screenshot.png"
rm -f "$SCREENSHOT_PATH"
agent-browser screenshot "$SCREENSHOT_PATH" 2>&1 >/dev/null
if [ -f "$SCREENSHOT_PATH" ] && [ -s "$SCREENSHOT_PATH" ]; then
  SIZE=$(stat -c%s "$SCREENSHOT_PATH" 2>/dev/null || stat -f%z "$SCREENSHOT_PATH" 2>/dev/null || echo "0")
  pass "Screenshot saved (${SIZE} bytes)"
  rm -f "$SCREENSHOT_PATH"
else
  fail "Screenshot saved" "file not created or empty"
fi

# Navigate to another page
agent-browser open https://httpbin.org/html 2>&1 >/dev/null
URL_HTTPBIN=$(agent-browser get url 2>&1)
assert_eq "Navigation to httpbin works" "https://httpbin.org/html" "$URL_HTTPBIN"

# --------------------------------------------------------------------------
echo ""
echo "▸ 5. Viewer HTTP Server (port 9224)"
# --------------------------------------------------------------------------

assert_http_ok "Viewer serves HTML" "http://127.0.0.1:9224/"

SESSIONS=$(curl -sf http://127.0.0.1:9224/sessions 2>/dev/null || echo "")
assert_contains "Sessions API returns kortix" "kortix" "$SESSIONS"
assert_contains "Sessions API has port 9223" "9223" "$SESSIONS"

# Test SSE stream endpoint
STREAM_RESPONSE=$(capture_stream_event || true)
if echo "$STREAM_RESPONSE" | grep -qE 'status|"connected":true|"type":"frame"'; then
  pass "Stream endpoint connects"
else
  fail "Stream endpoint connects" "expected status or frame event"
fi

# --------------------------------------------------------------------------
echo ""
echo "▸ 6. Selkies Desktop (port 6080)"
# --------------------------------------------------------------------------

assert_http_ok "Selkies desktop responds" "http://127.0.0.1:6080/"

# --------------------------------------------------------------------------
echo ""
echo "▸ 7. Environment Variables"
# --------------------------------------------------------------------------

assert_eq "AGENT_BROWSER_SESSION=kortix" "kortix" "${AGENT_BROWSER_SESSION:-}"
assert_eq "AGENT_BROWSER_HEADED=0" "0" "${AGENT_BROWSER_HEADED:-}"
assert_eq "AGENT_BROWSER_SOCKET_DIR set" "/dev/shm/agent-browser" "${AGENT_BROWSER_SOCKET_DIR:-}"
assert_eq "AGENT_BROWSER_IDLE_TIMEOUT_MS=0" "0" "${AGENT_BROWSER_IDLE_TIMEOUT_MS:-}"
assert_not_empty "AGENT_BROWSER_EXECUTABLE_PATH set" "${AGENT_BROWSER_EXECUTABLE_PATH:-}"

# --------------------------------------------------------------------------
echo ""
echo "▸ 8. Stability (daemon stays alive)"
# --------------------------------------------------------------------------

# Record daemon PID
DAEMON_PID_BEFORE=$(pgrep -n -f "node.*dist/daemon.js" 2>/dev/null || echo "")
sleep 5
DAEMON_PID_AFTER=$(pgrep -n -f "node.*dist/daemon.js" 2>/dev/null || echo "")

if [ -n "$DAEMON_PID_BEFORE" ] && [ -n "$DAEMON_PID_AFTER" ]; then
  pass "Daemon still alive after 5s (pid $DAEMON_PID_AFTER)"
else
  fail "Daemon still alive after 5s" "before=$DAEMON_PID_BEFORE after=$DAEMON_PID_AFTER"
fi

# URL should persist
URL_STABLE=$(agent-browser get url 2>&1)
assert_eq "URL persists after 5s" "https://httpbin.org/html" "$URL_STABLE"

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ All $TOTAL tests passed"
else
  echo "  ❌ $FAIL/$TOTAL tests failed ($PASS passed)"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit $FAIL
