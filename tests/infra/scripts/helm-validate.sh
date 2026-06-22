#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# For each Helm chart under infra/k8s/charts, render it (helm template) once per
# env values file in infra/k8s/envs/<env>/values.yaml, then pipe the rendered
# manifests through kubeconform. This catches both bad templates (helm fails)
# and invalid rendered K8s objects (kubeconform fails).
#
# Rendering runs in the alpine/helm image; validation in the kubeconform image.
# JUnit per chart+env -> test-results/infra/helm-<chart>-<env>.junit.xml.

mkdir -p "${RESULTS_DIR}"

CRD_SCHEMA='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

overall_rc=0

shopt -s nullglob
charts=("${CHARTS_DIR}"/*/)
if [ "${#charts[@]}" -eq 0 ]; then
  warn "No charts found under ${CHARTS_DIR}"
  exit 0
fi

for chart_dir in "${charts[@]}"; do
  chart_name="$(basename "${chart_dir}")"
  rel_chart="charts/${chart_name}"

  # A chart only applies to some envs (e.g. qa-portal is qa-only and its required
  # values aren't in the shared dev/preview/prod env files). An optional sibling
  # "<chart>.ci-envs" file (whitespace-separated env names) restricts rendering;
  # absent = render against every env (the default for app charts).
  allow_envs=""
  if [ -f "${CHARTS_DIR}/${chart_name}.ci-envs" ]; then
    allow_envs=" $(tr '\n' ' ' < "${CHARTS_DIR}/${chart_name}.ci-envs") "
  fi

  envs=("${K8S_DIR}"/envs/*/)
  if [ "${#envs[@]}" -eq 0 ]; then
    envs=("")
  fi

  for env_dir in "${envs[@]}"; do
    if [ -n "${env_dir}" ] && [ -f "${env_dir}values.yaml" ]; then
      env_name="$(basename "${env_dir}")"
      if [ -n "${allow_envs}" ] && [[ "${allow_envs}" != *" ${env_name} "* ]]; then
        log "skip ${chart_name} for env ${env_name} (not in ${chart_name}.ci-envs)"
        continue
      fi
      rel_values="envs/${env_name}/values.yaml"
      values_flag="--values /src/${rel_values}"
      label="${chart_name}-${env_name}"
    else
      values_flag=""
      label="${chart_name}-defaults"
    fi

    rendered="${RESULTS_DIR}/render-${label}.yaml"
    out_junit="${RESULTS_DIR}/helm-${label}.junit.xml"

    log "helm template ${chart_name} (${label})"
    set +e
    docker run --rm \
      -v "${K8S_DIR}:/src:ro" \
      --entrypoint /bin/sh \
      "${HELM_IMAGE}" -c "helm template ${label} /src/${rel_chart} ${values_flag}" \
      > "${rendered}"
    helm_rc=$?
    set -e

    if [ "${helm_rc}" -ne 0 ]; then
      err "helm template failed for ${label}"
      overall_rc=1
      continue
    fi

    log "kubeconform validate ${label}"
    set +e
    docker run --rm \
      -v "${rendered}:/manifest.yaml:ro" \
      "${KUBECONFORM_IMAGE}" \
        -kubernetes-version "${KUBERNETES_VERSION}" \
        -strict \
        -ignore-missing-schemas \
        -schema-location default \
        -schema-location "${CRD_SCHEMA}" \
        -summary \
        -output junit \
        /manifest.yaml > "${out_junit}"
    kc_rc=$?
    set -e

    [ "${kc_rc}" -ne 0 ] && overall_rc=1
    log "${label} JUnit -> ${out_junit} (helm=${helm_rc} kubeconform=${kc_rc})"
  done
done

exit "${overall_rc}"
