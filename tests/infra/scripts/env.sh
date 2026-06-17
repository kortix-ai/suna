#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export REPO_ROOT

export INFRA_DIR="${REPO_ROOT}/infra"
export TERRAFORM_DIR="${INFRA_DIR}/terraform"
export K8S_DIR="${INFRA_DIR}/k8s"
export CHARTS_DIR="${K8S_DIR}/charts"

export TESTS_INFRA_DIR="${REPO_ROOT}/tests/infra"
export RESULTS_DIR="${RESULTS_DIR:-${REPO_ROOT}/tests/test-results/infra}"

export TFLINT_IMAGE="ghcr.io/terraform-linters/tflint:v0.55.1"
export CHECKOV_IMAGE="bridgecrew/checkov:3.2.334"
export KUBECONFORM_IMAGE="ghcr.io/yannh/kubeconform:v0.6.7"
export HELM_IMAGE="alpine/helm:3.16.3"

export KUBERNETES_VERSION="${KUBERNETES_VERSION:-1.30.0}"

log()  { printf '\033[0;36m[infra]\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m[infra]\033[0m %s\n' "$*"; }
err()  { printf '\033[0;31m[infra]\033[0m %s\n' "$*" >&2; }

have_docker() {
  command -v docker >/dev/null 2>&1
}
