# Infrastructure Remediation Plan

> Status: **DRAFT — awaiting sign-off before implementation (Phase 3).**
> Scope: `suna-eks-migration` — EKS (prod eu-west-2, dev us-west-2) + Argo CD GitOps + ECS legacy.
> Author: Platform Engineering. Audience: CTO, platform engineers, and a skeptical Fortune-500 security reviewer.

---

## Executive Summary

This repository already has a credible GitOps + cloud-native foundation. This plan closes the gaps
that an enterprise security team will flag during procurement, **without re-architecting what works**
and **without risking the live production cluster** (prod serves real traffic; every change is staged
dev → prod and reversible by `git revert`).

### Maturity scorecard (current → target)

| # | Domain | Now | Target | Primary gap |
|---|---|----|----|---|
| 1 | Container strategy | 4 | 8 | No digest pin / HEALTHCHECK / OCI labels / scan / SBOM / signing |
| 2 | Kubernetes architecture | 4 | 9 | No securityContext, NetworkPolicy, PodSecurityAdmission, priorityClass |
| 3 | GitOps / Argo CD | 7 | 9 | `kortix-dev` on `default` project; no explicit sync waves; no SSO/notifications |
| 4 | Secret management | 7 | 9 | No documented rotation; working-tree cred files |
| 5 | CI pipeline quality | 4 | 9 | Mutable action tags; no test/SCA/container/IaC scan gates; partial SARIF |
| 6 | CD / progressive delivery | 5 | 9 | Canary written but disabled; no analysis gating in prod |
| 7 | Observability | 3 | 9 | **No alerting** (Alertmanager off, 0 rules); no tracing; no SLOs |
| 8 | Security posture (DevSecOps) | 3 | 9 | No SCA/container/IaC scan, admission control, runtime, signing, provenance |
| 9 | Networking | 5 | 8 | No NetworkPolicy/mTLS; external-dns wedged; no cert-manager |
| 10 | Multi-environment | 6 | 8 | No `staging`; previews share dev cluster w/o isolation |
| 11 | Disaster recovery | 2 | 8 | No Velero, RTO/RPO, runbooks, drills, chaos |
| 12 | Cost optimization | 3 | 7 | No Kubecost/OpenCost; no spot pools; no right-sizing |
| 13 | Compliance & audit | 5 | 8 | No Falco runtime; SOC2 control mapping informal |
| 14 | Developer experience | 5 | 8 | No Backstage/devcontainer; no ONBOARDING |
| 15 | Documentation & runbooks | 4 | 9 | No ADRs, runbooks, SECURITY.md, DR/IR docs |

**Aggregate: ~4.3 → ~8.4.**

### Estimated effort
~4–6 focused engineering weeks, delivered in 5 waves (below). Waves 1 and most of 4–5 are additive
and prod-safe; waves 2–3 touch running workloads and are staged dev-first with audit-before-enforce.

### Risk assessment
The dominant risk is not the *target* state — it's the *transition*. Two changes can break a running
service if applied blind: `readOnlyRootFilesystem`/`securityContext` (app may write to disk) and
`NetworkPolicy` default-deny (can sever required egress/DNS). Both are mitigated by: dev-first rollout,
audit-mode-before-enforce, and the existing canary + `git revert` rollback path.

---

## Architecture Overview

### Target state (text diagram)

```
Developer ──PR──> GitHub ──┬─ CI (ci.yml): lint · typecheck · UNIT TESTS+coverage gate
                           │       └─ SAST(CodeQL) · SCA(Trivy fs) · secret(gitleaks) · IaC(Checkov/tfsec)
                           │
              merge main ──┴─> CD-dev: build → Trivy image scan(gate) → SBOM(syft) → cosign sign+attest(SLSA)
                                        → bump envs/dev/values.yaml ──> Argo CD ──> dev-eks (us-west-2)
              promote PR ─────> CD-prod: retag → re-attest → bump envs/prod/values.yaml (approval gate)
                                        ──> Argo CD ──> prod-eks (eu-west-2)  [Argo Rollouts canary + analysis]

Cluster guardrails (both clusters, GitOps-managed):
  Kyverno (admission, audit→enforce) · PodSecurityAdmission(restricted) · NetworkPolicy(default-deny)
  Falco(runtime) · External Secrets(AWS SM) · Velero(backup) · cert-manager(future)

Observability (central, behind devops.<domain> SSO):
  Prometheus + recording/alerting rules → Alertmanager → Slack(warn)/PagerDuty(crit)
  Loki(logs) · Tempo(traces, OTel) · Grafana(golden-signals + SLO burn-rate + DORA dashboards)
```

### Technology choices (with justification — full ADRs in `docs/adr/`)

- **GitOps: Argo CD** (already adopted) over Flux — richer multi-source, ApplicationSet PR generator
  already powering previews, mature UI for the `devops.<domain>` console. *(ADR-001)*
- **Admission control: Kyverno** over OPA/Gatekeeper — policies are Kubernetes-native YAML (no Rego),
  and Kyverno can **generate** defaults (auto-create NetworkPolicy/PDB per namespace) and **mutate**
  (inject securityContext), which directly closes three of our gaps with one tool. Lower operational
  and review burden for a small platform team. *(ADR-002)*
- **Progressive delivery: Argo Rollouts canary** — the chart already ships `rollout.yaml` +
  `analysistemplate.yaml` (CloudWatch 5xx + p99). We enable, not build. *(ADR-003)*
- **Secrets: External Secrets Operator + AWS Secrets Manager** (already adopted); add rotation. *(ADR-004)*
- **Observability: OpenTelemetry + Prometheus + Loki + Tempo + Grafana** — extends the metrics+logs
  stack already deployed (`platform-metrics`, `platform-logs`). *(ADR-005)*
- **Supply chain: syft (SBOM) + cosign keyless (sign/attest) + SLSA provenance** via GitHub OIDC.

### What we remove / retire
- Legacy `modules/api-host` (Lightsail) and the ECS `dev/`+`prod/` import path — finish the EKS
  cutover or formally delete to eliminate desired-vs-actual drift.
- The wedged `external-dns` controller — either fix RBAC/IRSA so it manages DNS, or remove it so the
  cluster state matches reality (DNS stays manual + documented).
- Working-tree credential files (`grafana-creds.txt`, `headlamp-token.txt`) — replace with on-demand
  `kubectl create token` / SSO; they are gitignored but should not persist on disk.

---

## Phase-by-Phase Implementation

Each wave lists: objective · files · validation · rollback. Waves are ordered by **blast radius**:
zero-risk first, running-workload changes later (dev-first, audit-before-enforce).

### Wave 1 — Supply chain + CI gates + IaC hygiene + docs  *(zero cluster impact)*
**Objective:** make the pipeline and IaC auditable; ship the docs a security team reads first.
- **Files:** `.github/workflows/ci.yml` (add unit-test+coverage job, Trivy fs, gitleaks full-history),
  new `.github/workflows/security-scan.yml` (weekly Trivy image + Checkov/tfsec, SARIF upload),
  `deploy-*.yml` (Trivy image gate → syft SBOM → cosign sign+attest → SLSA provenance; pin every
  `uses:` to a commit SHA; add `timeout-minutes`), `.github/dependabot.yml` (add `terraform` ecosystem),
  `.github/CODEOWNERS` (second reviewer on security paths), each Dockerfile (digest-pin base,
  `HEALTHCHECK`, OCI labels), `infra/terraform/**` (extract `versions.tf`, add `validation{}`,
  AWS provider `< 6.0`), new `infra/terraform` CI (`fmt -check`/`validate`/`tflint`/`checkov`/drift),
  `docs/adr/00{1..5}-*.md`, `docs/runbooks/*.md`, `docs/ONBOARDING.md`, `docs/SECURITY.md`, README.
- **Validation:** PR runs all scans green; `trivy image --exit-code 1 --severity CRITICAL` passes on a
  freshly built image; `cosign verify` succeeds; `checkov -d infra/terraform` clean or waivered.
- **Rollback:** revert the workflow/Dockerfile commits — no runtime state changed.

### Wave 2 — Workload hardening  *(rolls pods; dev → prod via canary)*
**Objective:** every container runs least-privilege; metrics are scraped.
- **Files:** `charts/kortix-api/templates/_pod.tpl` + `migrate-job.yaml` (add `securityContext`:
  `runAsNonRoot`, `runAsUser`, `readOnlyRootFilesystem` + writable `emptyDir` for tmp/cache,
  `allowPrivilegeEscalation:false`, `seccompProfile: RuntimeDefault`, `capabilities.drop:[ALL]`),
  new `templates/servicemonitor.yaml`, new `templates/priorityclass` usage, wire distinct
  `health.livenessPath: /health/live` in each env values, `applications/dev.yaml` → `project: kortix`.
- **Validation:** dev pods Running + ready with hardened context; `/health/live` distinct from
  readiness; ServiceMonitor target UP in Prometheus; app smoke passes. Only then bump prod.
- **Rollback:** `git revert` the values/chart bump → Argo rolls back; canary auto-aborts on 5xx/p99.

### Wave 3 — Cluster guardrails  *(additive; audit-before-enforce)*
**Objective:** deny-by-default posture across both clusters.
- **Files:** new `infra/policies/kyverno/*` (Argo app, audit mode first: disallow latest tag, require
  digest, require limits, disallow privileged/hostNamespaces, require non-root, restrict registries,
  require team/env labels, **generate** default NetworkPolicy + PDB per namespace), PodSecurityAdmission
  labels on every namespace (`audit`/`warn` → then `enforce: restricted`), explicit NetworkPolicy
  baselines, `security/falco/*` (runtime rules → SIEM/Slack), Velero (`infra/k8s/argocd/applications/`
  app + schedules, cross-region backup for prod).
- **Validation:** Kyverno in `Audit` reports violations for a week with zero blocks; flip to `Enforce`
  per-namespace after clean; NetworkPolicy validated dev-first with connectivity tests; `velero backup`
  + test restore in a throwaway namespace (`scripts/dr-test.sh`).
- **Rollback:** policies are objects — set `validationFailureAction: Audit` or delete the Argo app.

### Wave 4 — Observability depth: alerting, SLOs, tracing, DORA  *(additive)*
**Objective:** the platform pages on real problems and proves SLOs.
- **Files:** `platform-metrics.yaml` (`alertmanager.enabled: true` + routing Slack/PagerDuty),
  `observability/alerts/*` (PrometheusRule: multi-window multi-burn-rate SLO alerts, with runbook URLs
  in annotations), `observability/slos/*`, `observability/dashboards/*.json` (golden signals, cluster,
  cost, security, **DORA**), `observability/otel/*` (OTel Collector DaemonSet → Tempo), Tempo Argo app,
  dev-us → central remote_write/log-push agent (cross-region single pane).
- **Validation:** fire a synthetic 5xx burst → burn-rate alert pages within SLA; trace a request
  ingress→service in Tempo with exemplar link from a metric.
- **Rollback:** disable the Argo apps / set Alertmanager back off.

### Wave 5 — Progressive delivery + cost + drift cleanup  *(prod-affecting, gated)*
**Objective:** every prod deploy is a canary with auto-rollback; cost is visible; drift is gone.
- **Files:** `envs/prod/values.yaml` (`rollout.enabled: true` + `analysis.enabled: true` with the
  live ALB/target-group dimensions), OpenCost/Kubecost Argo app, spot node group for dev/preview
  (`modules/eks` + tfvars), resolve external-dns IRSA or remove, retire Lightsail/ECS modules.
- **Validation:** a real prod release rides the canary (5→25→50→100%) and a deliberately-bad image
  auto-rolls-back on the analysis gate; cost dashboard renders.
- **Rollback:** `rollout.enabled: false` reverts to plain Deployment instantly.

---

## Security Control Mapping

| Change | SOC 2 | CIS K8s Benchmark | OWASP / SLSA |
|---|---|---|---|
| securityContext (non-root, no-priv-esc, drop caps, seccomp) | CC6.1, CC6.8 | 5.2.1–5.2.9 | OWASP K8s SC-A |
| PodSecurityAdmission `restricted` | CC6.1 | 5.2 | — |
| NetworkPolicy default-deny | CC6.1, CC6.6 | 5.3.2 | — |
| Kyverno admission (digest pin, registry allow-list) | CC6.1, CC8.1 | 5.1.x | SLSA L2 (provenance) |
| Trivy image scan gate | CC7.1 | — | OWASP A06 (vuln components) |
| cosign sign + SBOM + provenance | CC8.1 | — | **SLSA L3** (signed provenance) |
| External Secrets + rotation | CC6.1 | — | OWASP A02 (crypto failures) |
| Falco runtime detection | CC7.2 | — | — |
| Alerting + SLO burn-rate | CC7.2, A1.1 | — | — |
| Velero backup + DR drill | A1.2, A1.3 | — | — |
| OIDC (no static cloud creds) | CC6.1 | — | — |
| Audit: CloudTrail + GuardDuty (present) | CC7.1, CC7.2 | — | — |

**SLSA target: Level 3** — signed provenance generated by a trusted (GitHub OIDC) builder, on every
production container image. Currently Level 0–1 (build exists, no attestation).

---

## DORA Metrics Baseline

| Metric | Current | Instrumented? | Target |
|---|---|---|---|
| Deployment frequency | High (every merge→dev; promote→prod) | ❌ not measured | Measured from CI deploy events |
| Lead time for changes | Unknown | ❌ | commit→prod timestamp diff, p50/p90 |
| Change failure rate | Unknown | ❌ | rollback/incident events ÷ deploys |
| MTTR | Unknown | ❌ | alert-open → resolved from Alertmanager |

Wave 4 ships a DORA dashboard sourced from GitHub deployment events + Alertmanager.

---

## Dependency Graph (ordering constraints)

```
Wave 1 (CI/IaC/docs) ─ independent, do first
        └─ SBOM/cosign/provenance ─ needed before "SLSA L3" claim
Wave 2 (securityContext, ServiceMonitor) ─ ServiceMonitor BEFORE Wave 4 alerts (need scrape targets)
Wave 3 (Kyverno/PSA/NetworkPolicy/Velero) ─ MUST run audit-mode before enforce;
        Kyverno "require digest/limits" assumes Wave 1 (digests) + Wave 2 (limits already present)
Wave 4 (alerting/tracing/SLO/DORA) ─ depends on Wave 2 ServiceMonitor + OTel instrumentation
Wave 5 (canary enable, cost, drift) ─ depends on Wave 4 analysis metrics being reliable
```

---

## Known Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `readOnlyRootFilesystem` breaks the app (writes to disk) | Med | High | Dev-first; add `emptyDir` for known write paths; canary + revert |
| NetworkPolicy default-deny severs DNS/egress | Med | High | Audit/log mode first; explicit allow for kube-dns + Supabase + Secrets Mgr; dev-first |
| Kyverno enforce blocks a legit deploy | Med | Med | Ship in `Audit`; flip per-namespace only after a clean week |
| Trivy CRITICAL gate blocks all releases on a base-image CVE | Med | Med | `.trivyignore` with expiry + tracked waivers; distroless where possible |
| Action SHA-pinning breaks a workflow | Low | Low | Dependabot keeps SHAs current; revert is trivial |
| Velero restore unties live PVs | Low | High | Restore only into throwaway namespaces in drills; never over live |
| Enabling canary in prod during ECS→EKS dual-run | Low | Med | Enable only after cutover is final; `rollout.enabled:false` instant revert |

---

## Out of scope (tracked in `docs/WHATS_MISSING.md` after implementation)
External dependencies (PagerDuty account, SIEM endpoint, Vault if adopted, DNS zones), per-environment
secret values, and good-to-have tooling (Backstage IDP, Crossplane, service mesh/mTLS) are catalogued
separately so this plan stays executable.
