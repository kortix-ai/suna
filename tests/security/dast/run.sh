#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/test-results/security}"

ZAP_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:2.16.0}"
SCHEMATHESIS_IMAGE="${SCHEMATHESIS_IMAGE:-schemathesis/schemathesis:3.39.5}"

WANT_ZAP="${WANT_ZAP:-1}"
WANT_SCHEMATHESIS="${WANT_SCHEMATHESIS:-1}"

mkdir -p "${OUT_DIR}"

if [ -z "${TARGET_URL:-}" ]; then
  echo "[dast] ERROR: TARGET_URL is required (e.g. http://host.docker.internal:3000)" >&2
  echo "[dast] DAST/fuzzing must hit a dedicated/staging/local target — NEVER shared prod or dev." >&2
  exit 2
fi

case "${TARGET_URL}" in
  *prod*|*production*)
    echo "[dast] REFUSING: TARGET_URL looks like production. DAST must never run against prod." >&2
    exit 2
    ;;
esac

OPENAPI_URL="${OPENAPI_URL:-${TARGET_URL%/}/v1/openapi.json}"
GATE_FAIL=0

echo "[dast] target: ${TARGET_URL}"
echo "[dast] WARNING: this is active scanning + fuzzing. Confirm the target is"
echo "[dast]          a dedicated/staging/local instance, not shared prod/dev."

if [ "${WANT_ZAP}" = "1" ]; then
  echo "[dast] ZAP baseline ${ZAP_IMAGE}"
  echo "[dast] report -> ${OUT_DIR}/zap-baseline.html / .json"
  docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "${OUT_DIR}:/zap/wrk:rw" \
    "${ZAP_IMAGE}" \
    zap-baseline.py \
    -t "${TARGET_URL}" \
    -J zap-baseline.json \
    -r zap-baseline.html \
    -I || GATE_FAIL=1
fi

if [ "${WANT_SCHEMATHESIS}" = "1" ]; then
  echo "[dast] schemathesis ${SCHEMATHESIS_IMAGE}"
  echo "[dast] schema: ${OPENAPI_URL}"
  echo "[dast] junit -> ${OUT_DIR}/schemathesis-junit.xml"
  docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "${OUT_DIR}:/out" \
    "${SCHEMATHESIS_IMAGE}" \
    run "${OPENAPI_URL}" \
    --base-url "${TARGET_URL}" \
    --checks all \
    --hypothesis-max-examples "${SCHEMATHESIS_MAX_EXAMPLES:-50}" \
    --junit-xml /out/schemathesis-junit.xml \
    ${SCHEMATHESIS_HEADER:+--header "${SCHEMATHESIS_HEADER}"} || GATE_FAIL=1
fi

echo "[dast] done (gate ${GATE_FAIL})"
exit "${GATE_FAIL}"
