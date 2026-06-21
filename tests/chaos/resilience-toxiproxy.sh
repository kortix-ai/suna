#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix — Dependency chaos via Toxiproxy (OSS, shopify/toxiproxy)             ║
# ║                                                                               ║
# ║  Steady-state hypothesis:                                                     ║
# ║    "When a backing dependency (DB/Redis) becomes slow or partitioned, the     ║
# ║     API stays UP and degrades gracefully — it returns 5xx/timeout quickly     ║
# ║     instead of hanging, and fully recovers once the fault is cleared."        ║
# ║                                                                               ║
# ║  This needs a DEPLOYED / staging target (API + its dependency reachable).     ║
# ║  It is NOT a unit-CI test. See README for scoping.                            ║
# ║                                                                               ║
# ║  Usage:                                                                       ║
# ║    BASE_URL=http://localhost:8008/v1 PROXY=postgres ./resilience-toxiproxy.sh ║
# ║                                                                               ║
# ║  Env:                                                                         ║
# ║    BASE_URL     API base url to probe        (default http://localhost:8008/v1)║
# ║    HEALTH_PATH  health endpoint              (default /health)                 ║
# ║    TOXIPROXY    Toxiproxy admin api          (default http://localhost:8474)   ║
# ║    PROXY        proxy/dependency to disrupt  (default postgres)                ║
# ║    LATENCY_MS   injected latency             (default 4000)                    ║
# ║    OUT          results dir   (default <repo>/test-results/chaos)              ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BASE_URL="${BASE_URL:-http://localhost:8008/v1}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
TOXIPROXY="${TOXIPROXY:-http://localhost:8474}"
PROXY="${PROXY:-postgres}"
LATENCY_MS="${LATENCY_MS:-4000}"
OUT="${OUT:-$REPO_ROOT/tests/test-results/chaos}"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'; NC='\033[0m'

mkdir -p "$OUT"
REPORT="$OUT/resilience-${PROXY}.json"

PASS=0; FAIL=0
declare -a STEPS

record() {
  local name="$1" ok="$2" detail="$3"
  if [[ "$ok" == "true" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  STEPS+=("{\"name\":\"$name\",\"passed\":$ok,\"detail\":\"$detail\"}")
}

probe() {
  # echoes "<http_code> <total_seconds>"
  curl -s -o /dev/null -m 15 -w '%{http_code} %{time_total}' \
    "${BASE_URL%/}${HEALTH_PATH}" 2>/dev/null || echo "000 15.0"
}

steady_state_ok() {
  local result code
  result="$(probe)"; code="${result%% *}"
  [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]
}

api() { curl -s -m 10 "$@"; }

echo -e "${CYAN}━━━ Toxiproxy resilience: proxy='${PROXY}' target='${BASE_URL}' ━━━${NC}"

# 1. Preconditions
if ! api "$TOXIPROXY/version" >/dev/null; then
  echo -e "${RED}✗ Toxiproxy admin API not reachable at $TOXIPROXY${NC}" >&2
  echo "  Start it:  docker compose -f $SCRIPT_DIR/docker-compose.toxiproxy.yml up -d" >&2
  exit 3
fi

if ! api "$TOXIPROXY/proxies/$PROXY" | grep -q '"name"'; then
  echo -e "${RED}✗ Proxy '$PROXY' not defined in Toxiproxy (see toxiproxy.json)${NC}" >&2
  exit 3
fi

# 2. Steady state BEFORE fault
echo -e "${CYAN}• Verifying steady state (baseline)…${NC}"
if steady_state_ok; then
  echo -e "${GREEN}  ✓ baseline healthy${NC}"; record "baseline_steady_state" true "API healthy before fault"
else
  echo -e "${RED}  ✗ baseline NOT healthy — aborting (cannot attribute failures to chaos)${NC}" >&2
  record "baseline_steady_state" false "API unhealthy before fault"
  printf '{"proxy":"%s","passed":%d,"failed":%d,"steps":[%s]}\n' \
    "$PROXY" "$PASS" "$FAIL" "$(IFS=,; echo "${STEPS[*]}")" > "$REPORT"
  exit 1
fi

cleanup() {
  echo -e "${YELLOW}• Removing injected toxics…${NC}"
  api -X DELETE "$TOXIPROXY/proxies/$PROXY/toxics/chaos_latency" >/dev/null 2>&1 || true
  api -X DELETE "$TOXIPROXY/proxies/$PROXY/toxics/chaos_partition" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 3. Inject LATENCY on the dependency
echo -e "${CYAN}• Injecting ${LATENCY_MS}ms latency on '${PROXY}'…${NC}"
api -X POST "$TOXIPROXY/proxies/$PROXY/toxics" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"chaos_latency\",\"type\":\"latency\",\"stream\":\"downstream\",\"attributes\":{\"latency\":$LATENCY_MS}}" \
  >/dev/null

LAT_RESULT="$(probe)"; LAT_CODE="${LAT_RESULT%% *}"; LAT_TIME="${LAT_RESULT##* }"
echo "  response under latency: code=$LAT_CODE time=${LAT_TIME}s"
# Graceful degradation = bounded response (no infinite hang). We accept any
# answer that returns within the curl timeout; a total hang -> code 000.
if [[ "$LAT_CODE" != "000" ]]; then
  record "degrades_under_latency" true "code=$LAT_CODE time=${LAT_TIME}s (bounded, no hang)"
  echo -e "${GREEN}  ✓ bounded response under dependency latency${NC}"
else
  record "degrades_under_latency" false "request hung past timeout"
  echo -e "${RED}  ✗ request hung — no graceful timeout/degradation${NC}"
fi
api -X DELETE "$TOXIPROXY/proxies/$PROXY/toxics/chaos_latency" >/dev/null 2>&1 || true

# 4. Inject PARTITION (disable proxy entirely)
echo -e "${CYAN}• Partitioning '${PROXY}' (proxy disabled)…${NC}"
api -X POST "$TOXIPROXY/proxies/$PROXY" \
  -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null

PART_RESULT="$(probe)"; PART_CODE="${PART_RESULT%% *}"; PART_TIME="${PART_RESULT##* }"
echo "  response under partition: code=$PART_CODE time=${PART_TIME}s"
# We want the process to STAY UP and answer fast (any non-hang). For a
# dependency-dependent endpoint a fast 5xx is acceptable graceful failure.
if [[ "$PART_CODE" != "000" ]]; then
  record "stays_up_under_partition" true "code=$PART_CODE time=${PART_TIME}s (process alive, fast fail)"
  echo -e "${GREEN}  ✓ API process stayed up and failed fast${NC}"
else
  record "stays_up_under_partition" false "no response within timeout under partition"
  echo -e "${RED}  ✗ API hung / unresponsive under partition${NC}"
fi

# 5. Re-enable and verify RECOVERY
echo -e "${CYAN}• Healing partition and checking recovery…${NC}"
api -X POST "$TOXIPROXY/proxies/$PROXY" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null

RECOVERED=false
for i in $(seq 1 15); do
  if steady_state_ok; then RECOVERED=true; break; fi
  sleep 2
done
if [[ "$RECOVERED" == "true" ]]; then
  record "recovers_after_heal" true "steady state restored after fault cleared"
  echo -e "${GREEN}  ✓ recovered to steady state${NC}"
else
  record "recovers_after_heal" false "did not return to steady state within 30s"
  echo -e "${RED}  ✗ did not recover within 30s${NC}"
fi

printf '{"proxy":"%s","baseUrl":"%s","passed":%d,"failed":%d,"steps":[%s]}\n' \
  "$PROXY" "$BASE_URL" "$PASS" "$FAIL" "$(IFS=,; echo "${STEPS[*]}")" > "$REPORT"

echo ""
echo -e "${CYAN}━━━ result: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} → $REPORT${NC}"
[[ "$FAIL" -eq 0 ]]
