#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scripts/env.sh"

# Orchestrates all Infrastructure-as-Code static checks. Everything runs in
# Docker — no host terraform/checkov/helm/kubeconform needed.
#
# Steps (each writes JUnit/SARIF to test-results/infra/):
#   - tflint        Terraform lint over infra/terraform
#   - checkov       Terraform security scan (SARIF + JUnit), soft-fail
#   - kubeconform   validate raw manifests under infra/k8s (excl. charts/)
#   - helm-validate render charts per env, then kubeconform the output
#
# Env:
#   SUITES="tflint checkov kubeconform helm"   subset to run (default: all)
#   SOFT_FAIL=0                                 make checkov findings fail
#   KUBERNETES_VERSION=1.30.0                   schema version for kubeconform

if ! have_docker; then
  err "docker not found on PATH — all infra checks are Docker-invoked"
  exit 127
fi

mkdir -p "${RESULTS_DIR}"

SUITES="${SUITES:-tflint checkov kubeconform helm}"
overall_rc=0

run_suite() {
  local name="$1" script="$2"
  log "==== ${name} ===="
  if bash "${SCRIPT_DIR}/scripts/${script}"; then
    log "${name} OK"
  else
    err "${name} reported failures"
    overall_rc=1
  fi
}

for suite in ${SUITES}; do
  case "${suite}" in
    tflint)       run_suite "tflint"       "tflint.sh" ;;
    checkov)      run_suite "checkov"      "checkov.sh" ;;
    kubeconform)  run_suite "kubeconform"  "kubeconform.sh" ;;
    helm)         run_suite "helm-validate" "helm-validate.sh" ;;
    *)            warn "unknown suite '${suite}' — skipping" ;;
  esac
done

if [ "${overall_rc}" -eq 0 ]; then
  log "All infra checks passed. Results in ${RESULTS_DIR}"
else
  err "Some infra checks failed. See ${RESULTS_DIR}"
fi
exit "${overall_rc}"
