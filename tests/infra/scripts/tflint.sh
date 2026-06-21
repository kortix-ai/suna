#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# tflint over every Terraform root/module under infra/terraform.
# Recursive mode (--recursive) lints each directory containing *.tf.
# JUnit output to test-results/infra/tflint.junit.xml.

mkdir -p "${RESULTS_DIR}"
OUT_JUNIT="${RESULTS_DIR}/tflint.junit.xml"

log "Running tflint (${TFLINT_IMAGE}) over ${TERRAFORM_DIR}"

docker run --rm \
  -v "${TERRAFORM_DIR}:/data" \
  -v "${TESTS_INFRA_DIR}/.tflint.hcl:/data/.tflint.hcl:ro" \
  -w /data \
  --entrypoint /bin/sh \
  "${TFLINT_IMAGE}" -c "tflint --init --config /data/.tflint.hcl" || {
    err "tflint --init failed"
    exit 1
  }

set +e
docker run --rm \
  -v "${TERRAFORM_DIR}:/data" \
  -v "${TESTS_INFRA_DIR}/.tflint.hcl:/data/.tflint.hcl:ro" \
  -w /data \
  "${TFLINT_IMAGE}" \
  --recursive \
  --config /data/.tflint.hcl \
  --format junit > "${OUT_JUNIT}"
rc=$?
set -e

log "tflint JUnit -> ${OUT_JUNIT} (exit ${rc})"
exit "${rc}"
