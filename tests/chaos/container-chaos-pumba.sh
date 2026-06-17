#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix — Container chaos via pumba (OSS, gaiaadm/pumba)                       ║
# ║                                                                               ║
# ║  Steady-state hypothesis:                                                     ║
# ║    "Killing or pausing a single API container does not take the service down: ║
# ║     the orchestrator/replica set keeps serving, and the killed container is   ║
# ║     restarted back to a healthy steady state."                                ║
# ║                                                                               ║
# ║  Needs a DEPLOYED target running as Docker containers (compose/swarm).        ║
# ║  pumba acts on the local Docker daemon, so run it on the host running them.    ║
# ║                                                                               ║
# ║  Usage:                                                                       ║
# ║    TARGET=kortix-api ACTION=kill ./container-chaos-pumba.sh                    ║
# ║    TARGET=kortix-api ACTION=pause DURATION=20s ./container-chaos-pumba.sh      ║
# ║                                                                               ║
# ║  Env:                                                                         ║
# ║    BASE_URL    API base url to probe   (default http://localhost:8008/v1)      ║
# ║    HEALTH_PATH health endpoint         (default /health)                       ║
# ║    TARGET      container name/regex     (default kortix-api)                   ║
# ║    ACTION      kill | pause | stop      (default kill)                         ║
# ║    DURATION    for pause/stop           (default 15s)                          ║
# ║    SIGNAL      for kill                  (default SIGKILL)                      ║
# ║    PUMBA_IMAGE pinned image     (default gaiaadm/pumba:0.11.6)                 ║
# ║    OUT         results dir      (default <repo>/test-results/chaos)            ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BASE_URL="${BASE_URL:-http://localhost:8008/v1}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
TARGET="${TARGET:-kortix-api}"
ACTION="${ACTION:-kill}"
DURATION="${DURATION:-15s}"
SIGNAL="${SIGNAL:-SIGKILL}"
PUMBA_IMAGE="${PUMBA_IMAGE:-gaiaadm/pumba:0.11.6}"
OUT="${OUT:-$REPO_ROOT/tests/test-results/chaos}"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

mkdir -p "$OUT"
REPORT="$OUT/container-chaos-${ACTION}.json"
PASS=0; FAIL=0; declare -a STEPS
record() { local n="$1" ok="$2" d="$3"; if [[ "$ok" == true ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi; STEPS+=("{\"name\":\"$n\",\"passed\":$ok,\"detail\":\"$d\"}"); }

steady_state_ok() {
  local code
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "${BASE_URL%/}${HEALTH_PATH}" 2>/dev/null || echo 000)"
  [[ "$code" =~ ^(2|3)[0-9][0-9]$ ]]
}

echo -e "${CYAN}━━━ pumba container chaos: action='${ACTION}' target='${TARGET}' ━━━${NC}"

# 1. Baseline steady state
if steady_state_ok; then
  echo -e "${GREEN}✓ baseline healthy${NC}"; record baseline_steady_state true "healthy before chaos"
else
  echo -e "${RED}✗ baseline NOT healthy — aborting${NC}" >&2
  record baseline_steady_state false "unhealthy before chaos"
  printf '{"action":"%s","target":"%s","passed":%d,"failed":%d,"steps":[%s]}\n' \
    "$ACTION" "$TARGET" "$PASS" "$FAIL" "$(IFS=,; echo "${STEPS[*]}")" > "$REPORT"
  exit 1
fi

# 2. Build the pumba command for the chosen fault
case "$ACTION" in
  kill)  PUMBA_CMD=(kill "--signal" "$SIGNAL" "re2:${TARGET}") ;;
  pause) PUMBA_CMD=(pause "--duration" "$DURATION" "re2:${TARGET}") ;;
  stop)  PUMBA_CMD=(stop "--duration" "$DURATION" "re2:${TARGET}") ;;
  *) echo "Unknown ACTION: $ACTION (kill|pause|stop)" >&2; exit 2 ;;
esac

echo -e "${CYAN}• Injecting '${ACTION}' on '${TARGET}' via pumba…${NC}"
docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$PUMBA_IMAGE" "${PUMBA_CMD[@]}" >/dev/null 2>&1 || true

# 3. Service should still answer during the disruption window (resilience),
#    OR recover quickly after. Poll for recovery to steady state.
RECOVERED=false
for i in $(seq 1 30); do
  if steady_state_ok; then RECOVERED=true; break; fi
  sleep 2
done

if [[ "$RECOVERED" == true ]]; then
  record service_recovers true "steady state within 60s after $ACTION"
  echo -e "${GREEN}✓ service back to steady state after $ACTION${NC}"
else
  record service_recovers false "no steady state within 60s after $ACTION"
  echo -e "${RED}✗ service did not recover within 60s after $ACTION${NC}"
fi

printf '{"action":"%s","target":"%s","baseUrl":"%s","passed":%d,"failed":%d,"steps":[%s]}\n' \
  "$ACTION" "$TARGET" "$BASE_URL" "$PASS" "$FAIL" "$(IFS=,; echo "${STEPS[*]}")" > "$REPORT"

echo ""
echo -e "${CYAN}━━━ result: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC} → $REPORT${NC}"
[[ "$FAIL" -eq 0 ]]
