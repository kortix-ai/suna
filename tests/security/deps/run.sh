#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/test-results/security}"

TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.58.0}"
OSV_IMAGE="${OSV_IMAGE:-ghcr.io/google/osv-scanner:v1.9.2}"
SEVERITY="${SEVERITY:-CRITICAL,HIGH}"

mkdir -p "${OUT_DIR}"
GATE_FAIL=0

echo "[deps] trivy fs ${TRIVY_IMAGE} (severity ${SEVERITY})"
echo "[deps] sarif -> ${OUT_DIR}/trivy-deps.sarif | json -> ${OUT_DIR}/trivy-deps.json"

docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -v "${OUT_DIR}:/out" \
  "${TRIVY_IMAGE}" \
  fs /src \
  --scanners vuln,license \
  --format sarif --output /out/trivy-deps.sarif

docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -v "${OUT_DIR}:/out" \
  "${TRIVY_IMAGE}" \
  fs /src \
  --scanners vuln \
  --severity "${SEVERITY}" \
  --exit-code 1 \
  --format json --output /out/trivy-deps.json || GATE_FAIL=1

echo "[deps] osv-scanner ${OSV_IMAGE}"
echo "[deps] json -> ${OUT_DIR}/osv.json"

docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -v "${OUT_DIR}:/out" \
  "${OSV_IMAGE}" \
  scan --recursive --format json --output /out/osv.json /src || GATE_FAIL=1

echo "[deps] done (gate ${GATE_FAIL})"
exit "${GATE_FAIL}"
