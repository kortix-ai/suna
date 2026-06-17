#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/test-results/security}"
IMAGE="${SEMGREP_IMAGE:-returntocorp/semgrep:1.97.0}"

mkdir -p "${OUT_DIR}"

CONFIG="${SEMGREP_CONFIG:-p/default p/typescript p/javascript p/owasp-top-ten p/secrets /src/tests/security/sast/semgrep.yml}"

CONFIG_ARGS=()
for c in ${CONFIG}; do
  CONFIG_ARGS+=("--config" "${c}")
done

echo "[sast] semgrep ${IMAGE}"
echo "[sast] configs: ${CONFIG}"
echo "[sast] sarif -> ${OUT_DIR}/semgrep.sarif"

docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -v "${OUT_DIR}:/out" \
  -w /src \
  "${IMAGE}" \
  semgrep scan \
  "${CONFIG_ARGS[@]}" \
  --sarif --output /out/semgrep.sarif \
  --metrics off \
  --error \
  --severity ERROR \
  "${SEMGREP_EXTRA_ARGS:-}" || EXIT=$?

echo "[sast] done (exit ${EXIT:-0})"
exit "${EXIT:-0}"
