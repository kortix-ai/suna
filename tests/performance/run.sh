#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix — Performance test runner (k6 via Docker, no local install)           ║
# ║                                                                               ║
# ║  Usage:                                                                       ║
# ║    ./run.sh <profile> [BASE_URL]                                              ║
# ║    BASE_URL=https://staging.example.com/v1 ./run.sh load                      ║
# ║                                                                               ║
# ║  Profiles: load | stress | spike | soak                                       ║
# ║                                                                               ║
# ║  Env:                                                                         ║
# ║    BASE_URL        target API base url   (default http://localhost:8008/v1)   ║
# ║    AUTH_TOKEN      optional bearer token for authenticated endpoints          ║
# ║    ENDPOINTS       comma list of paths to browse (default /health)            ║
# ║    K6_IMAGE        k6 docker image       (default grafana/k6:0.54.0)          ║
# ║    K6_PROMETHEUS_RW_SERVER_URL  enable Prometheus remote-write output         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

PROFILE="${1:-load}"
BASE_URL="${2:-${BASE_URL:-http://localhost:8008/v1}}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_HOST_DIR="$REPO_ROOT/tests/test-results/performance"
K6_IMAGE="${K6_IMAGE:-grafana/k6:0.54.0}"

case "$PROFILE" in
  load|stress|spike|soak) ;;
  *)
    echo "Unknown profile: $PROFILE (expected load|stress|spike|soak)" >&2
    exit 2
    ;;
esac

mkdir -p "$RESULTS_HOST_DIR"

# On Linux, localhost inside the container is the container itself.
# host.docker.internal lets the container reach a service on the host.
RUN_URL="$BASE_URL"
if [[ "$BASE_URL" == *"localhost"* || "$BASE_URL" == *"127.0.0.1"* ]]; then
  RUN_URL="${BASE_URL/localhost/host.docker.internal}"
  RUN_URL="${RUN_URL/127.0.0.1/host.docker.internal}"
fi

DOCKER_ARGS=(
  run --rm
  --add-host=host.docker.internal:host-gateway
  -e "BASE_URL=$RUN_URL"
  -e "RESULTS_DIR=/results"
  -e "AUTH_TOKEN=${AUTH_TOKEN:-}"
  -e "ENDPOINTS=${ENDPOINTS:-/health}"
  -v "$SCRIPT_DIR:/scripts:ro"
  -v "$RESULTS_HOST_DIR:/results"
)

K6_OUT=()
if [[ -n "${K6_PROMETHEUS_RW_SERVER_URL:-}" ]]; then
  DOCKER_ARGS+=(-e "K6_PROMETHEUS_RW_SERVER_URL=$K6_PROMETHEUS_RW_SERVER_URL")
  DOCKER_ARGS+=(-e "K6_PROMETHEUS_RW_TREND_STATS=p(95),p(99),avg,max")
  K6_OUT=(--out experimental-prometheus-rw)
fi

echo "▶ k6 profile=$PROFILE target=$RUN_URL image=$K6_IMAGE"
echo "▶ results -> $RESULTS_HOST_DIR/${PROFILE}-summary.json (+ -junit.xml)"

set +e
docker "${DOCKER_ARGS[@]}" "$K6_IMAGE" run "${K6_OUT[@]}" "/scripts/${PROFILE}.js"
STATUS=$?
set -e

if [[ $STATUS -ne 0 ]]; then
  echo "✗ k6 exited non-zero ($STATUS) — an SLO threshold was breached (quality gate failed)." >&2
else
  echo "✓ k6 passed all thresholds."
fi

exit $STATUS
