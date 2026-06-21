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

# Init + lint must run in the SAME container: `tflint --init` installs the aws
# ruleset into the container's plugin dir, which a separate `docker run` can't
# see ("Plugin aws not found"). Init stdout is dropped so only the recursive
# JUnit reaches OUT_JUNIT.
set +e
docker run --rm \
  -v "${TERRAFORM_DIR}:/data" \
  -v "${TESTS_INFRA_DIR}/.tflint.hcl:/data/.tflint.hcl:ro" \
  -w /data \
  --entrypoint /bin/sh \
  "${TFLINT_IMAGE}" -c \
  "tflint --init --config /data/.tflint.hcl >/dev/null && tflint --recursive --config /data/.tflint.hcl --format junit" \
  > "${OUT_JUNIT}"
rc=$?
set -e

log "tflint JUnit -> ${OUT_JUNIT} (exit ${rc})"
exit "${rc}"
