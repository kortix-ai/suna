# Infrastructure-as-Code tests

Static validation of `infra/terraform` and `infra/k8s`. Every check is OSS and
**Docker-invoked** — no host terraform / checkov / helm / kubeconform needed
(except the optional Go terratest stub). Output is JUnit + SARIF in
`test-results/infra/`.

## Checks

| Suite | Tool | Image | Target | Output |
|-------|------|-------|--------|--------|
| `tflint` | tflint + AWS ruleset | `ghcr.io/terraform-linters/tflint:v0.55.1` | `infra/terraform` (recursive) | `tflint.junit.xml` |
| `checkov` | checkov | `bridgecrew/checkov:3.2.334` | `infra/terraform` | `checkov.sarif`, `checkov.junit.xml` |
| `kubeconform` | kubeconform | `ghcr.io/yannh/kubeconform:v0.6.7` | `infra/k8s` (raw, excl. `charts/`) | `kubeconform.junit.xml` |
| `helm` | helm + kubeconform | `alpine/helm:3.16.3` + kubeconform | `infra/k8s/charts/*` rendered per env | `helm-<chart>-<env>.junit.xml` |

### Notes on the K8s manifests

- The raw manifests under `infra/k8s` include Argo CD `Application`/`AppProject`
  and chart templates. kubeconform validates everything except `charts/` (whose
  raw templates contain Go templating and aren't valid YAML until rendered).
- CRDs used here (`argoproj.io` Rollout/AnalysisTemplate, `external-secrets.io`
  ExternalSecret/SecretStore) are resolved from the
  [datreeio CRDs-catalog](https://github.com/datreeio/CRDs-catalog).
  `-ignore-missing-schemas` is the fallback for anything not in the catalog.
- `helm` suite renders each chart in `infra/k8s/charts/` once per env values
  file in `infra/k8s/envs/<env>/values.yaml`, then validates the rendered
  output. A bad template fails at `helm template`; an invalid object fails at
  kubeconform.

## Run

```bash
# Everything
bash tests/infra/run.sh

# A subset
SUITES="tflint kubeconform" bash tests/infra/run.sh

# Make checkov findings fail the build (default: soft-fail / report-only)
SOFT_FAIL=0 bash tests/infra/run.sh

# Pin the Kubernetes schema version used by kubeconform
KUBERNETES_VERSION=1.29.0 bash tests/infra/run.sh
```

Individual suites:

```bash
bash tests/infra/scripts/tflint.sh
bash tests/infra/scripts/checkov.sh
bash tests/infra/scripts/kubeconform.sh
bash tests/infra/scripts/helm-validate.sh
```

## Config

- `tests/infra/.tflint.hcl` — tflint plugins/rules (terraform recommended preset
  + AWS ruleset).
- `tests/infra/.checkov.yml` — checkov framework, soft-fail, and skip list.

## terratest (optional)

A Go-based plan/validate example lives in `tests/infra/terratest/`. It needs a
Go toolchain and is deliberately **not** part of `run.sh`. See
`terratest/README.md`.

## Prerequisites

- Docker (the only requirement for `run.sh`).
- Network access on first run to pull the images above and (for kubeconform CRD
  validation) fetch CRD schemas from the datreeio catalog.
- Go >= 1.22 **only** if you run the optional terratest example.
