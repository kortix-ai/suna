#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# kubeconform over the raw (non-templated) manifests under infra/k8s, excluding
# the Helm charts dir (those go through helm-validate.sh after templating, since
# raw chart templates contain Go templating that is not valid YAML).
#
# CRDs used by this repo (argoproj.io Rollout/AnalysisTemplate,
# external-secrets.io ExternalSecret/SecretStore) are resolved from the
# datreeio CRDs-catalog. -ignore-missing-schemas is the safety net for anything
# not in the catalog. JUnit -> test-results/infra/kubeconform.junit.xml.

mkdir -p "${RESULTS_DIR}"
OUT_JUNIT="${RESULTS_DIR}/kubeconform.junit.xml"

CRD_SCHEMA='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

log "Running kubeconform (${KUBECONFORM_IMAGE}) over ${K8S_DIR} (excluding charts/)"

set +e
docker run --rm \
  -v "${K8S_DIR}:/manifests:ro" \
  "${KUBECONFORM_IMAGE}" \
    -kubernetes-version "${KUBERNETES_VERSION}" \
    -strict \
    -ignore-missing-schemas \
    -schema-location default \
    -schema-location "${CRD_SCHEMA}" \
    -ignore-filename-pattern '^/manifests/charts/.*' \
    -summary \
    -output junit \
    /manifests > "${OUT_JUNIT}"
rc=$?
set -e

log "kubeconform JUnit -> ${OUT_JUNIT} (exit ${rc})"
exit "${rc}"
