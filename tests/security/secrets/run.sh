#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/test-results/security}"

IMAGE="${GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.30.1}"
MODE="${GITLEAKS_MODE:-dir}"

mkdir -p "${OUT_DIR}"

echo "[secrets] gitleaks ${IMAGE} (mode ${MODE})"
echo "[secrets] config: /src/.gitleaks.toml"
echo "[secrets] report -> ${OUT_DIR}/gitleaks.sarif"

docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -v "${OUT_DIR}:/out" \
  "${IMAGE}" \
  "${MODE}" /src \
  --config /src/.gitleaks.toml \
  --report-format sarif \
  --report-path /out/gitleaks.sarif \
  --redact \
  --verbose \
  --exit-code 1 || EXIT=$?

echo "[secrets] done (exit ${EXIT:-0})"
exit "${EXIT:-0}"
