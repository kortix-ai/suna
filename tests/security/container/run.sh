#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/test-results/security}"

TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.58.0}"
SEVERITY="${SEVERITY:-CRITICAL,HIGH}"
BUILD="${BUILD:-1}"

mkdir -p "${OUT_DIR}"
GATE_FAIL=0

APPS_DEFAULT="api web sandbox"
APPS="${APPS:-${APPS_DEFAULT}}"

for app in ${APPS}; do
  dockerfile="${REPO_ROOT}/apps/${app}/Dockerfile"
  if [ ! -f "${dockerfile}" ]; then
    echo "[container] skip ${app}: no Dockerfile"
    continue
  fi

  tag="kortix-${app}:sec-scan"

  if [ "${BUILD}" = "1" ]; then
    echo "[container] build ${tag} from apps/${app}/Dockerfile"
    docker build -t "${tag}" -f "${dockerfile}" "${REPO_ROOT}"
  fi

  echo "[container] trivy image ${tag} (severity ${SEVERITY})"
  echo "[container] sarif -> ${OUT_DIR}/trivy-image-${app}.sarif"

  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${OUT_DIR}:/out" \
    "${TRIVY_IMAGE}" \
    image "${tag}" \
    --scanners vuln,secret \
    --format sarif --output "/out/trivy-image-${app}.sarif"

  docker run --rm \
    -v /var/run/docker.sock:/var/run/docker.sock \
    "${TRIVY_IMAGE}" \
    image "${tag}" \
    --scanners vuln \
    --severity "${SEVERITY}" \
    --exit-code 1 \
    --quiet || GATE_FAIL=1
done

echo "[container] done (gate ${GATE_FAIL})"
exit "${GATE_FAIL}"
