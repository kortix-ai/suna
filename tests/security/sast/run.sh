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

EXTRA_ARGS=()
if [ -n "${SEMGREP_EXTRA_ARGS:-}" ]; then
  read -r -a EXTRA_ARGS <<< "${SEMGREP_EXTRA_ARGS}"
fi

GIT_MOUNT=()
if [ -f "${REPO_ROOT}/.git" ]; then
  GIT_COMMON_DIR="$(git -C "${REPO_ROOT}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "${GIT_COMMON_DIR}" ] && [ -d "${GIT_COMMON_DIR}" ]; then
    GIT_MOUNT=(-v "${REPO_ROOT}:${REPO_ROOT}:ro" -v "${GIT_COMMON_DIR}:${GIT_COMMON_DIR}:ro")
  fi
fi

echo "[sast] semgrep ${IMAGE}"
echo "[sast] configs: ${CONFIG}"
echo "[sast] sarif -> ${OUT_DIR}/semgrep.sarif"

docker run --rm \
  -v "${REPO_ROOT}:/src:ro" \
  -v "${OUT_DIR}:/out" \
  -w /src \
  -e HOME=/tmp \
  -e GIT_CONFIG_COUNT=1 \
  -e GIT_CONFIG_KEY_0=safe.directory \
  -e GIT_CONFIG_VALUE_0='*' \
  ${GIT_MOUNT[@]+"${GIT_MOUNT[@]}"} \
  "${IMAGE}" \
  semgrep scan \
  "${CONFIG_ARGS[@]}" \
  --sarif --output /out/semgrep.sarif \
  --metrics off \
  --error \
  --severity ERROR \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} || EXIT=$?

echo "[sast] done (exit ${EXIT:-0})"
exit "${EXIT:-0}"
