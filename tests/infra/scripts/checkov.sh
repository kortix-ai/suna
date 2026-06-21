#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# checkov static security/compliance scan over infra/terraform.
# Emits BOTH SARIF and JUnit to test-results/infra/.
# soft-fail is set in .checkov.yml so findings are reported without breaking
# the orchestrator; flip SOFT_FAIL=0 to make findings fail the build.

mkdir -p "${RESULTS_DIR}"

log "Running checkov (${CHECKOV_IMAGE}) over ${TERRAFORM_DIR}"

EXTRA_ARGS=()
if [ "${SOFT_FAIL:-1}" = "0" ]; then
  EXTRA_ARGS+=("--hard-fail-on" "MEDIUM")
fi

set +e
docker run --rm \
  -v "${TERRAFORM_DIR}:/tf:ro" \
  -v "${TESTS_INFRA_DIR}/.checkov.yml:/cfg/.checkov.yml:ro" \
  -v "${RESULTS_DIR}:/out" \
  "${CHECKOV_IMAGE}" \
  --directory /tf \
  --config-file /cfg/.checkov.yml \
  --output sarif --output junitxml \
  --output-file-path /out/checkov.sarif,/out/checkov.junit.xml \
  ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
rc=$?
set -e

# checkov writes results/results_sarif.sarif & results_junitxml.xml inside the
# output-file-path dirs; normalise to predictable names if needed.
[ -f "${RESULTS_DIR}/checkov.sarif/results_sarif.sarif" ] && \
  mv -f "${RESULTS_DIR}/checkov.sarif/results_sarif.sarif" "${RESULTS_DIR}/checkov.sarif.json" 2>/dev/null || true
[ -f "${RESULTS_DIR}/checkov.junit.xml/results_junitxml.xml" ] && \
  mv -f "${RESULTS_DIR}/checkov.junit.xml/results_junitxml.xml" "${RESULTS_DIR}/checkov.junit-results.xml" 2>/dev/null || true

log "checkov SARIF + JUnit -> ${RESULTS_DIR} (exit ${rc})"

if [ "${SOFT_FAIL:-1}" = "1" ]; then
  exit 0
fi
exit "${rc}"
