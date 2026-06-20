# What's Missing — Honest Gap Catalog

A deliberately honest list of what is **not yet built, provisioned, or filled in**
on this platform, so nobody mistakes a runbook's *intended* state for the *live*
state. Cross-referenced to `docs/INFRASTRUCTURE_PLAN.md` (the remediation plan
and its 5 waves). Keep this current — it's the first doc a reviewer (and a new
hire) should trust.

Maturity baseline today: **~4.3 / 10 aggregate**, target **~8.4**
(`docs/INFRASTRUCTURE_PLAN.md` scorecard).

---

## 1. External dependencies to provision

These are accounts/endpoints/zones owned outside the repo. Until they exist, the
corresponding automation is stubbed or manual.

| Dependency | Needed for | Status / blocker |
|---|---|---|
| **PagerDuty account + service** | SEV1/crit paging from Alertmanager | **Not provisioned.** Escalation is manual (Slack/phone) — see `docs/runbooks/incident-response.md`. Wave 4 routes Alertmanager → PagerDuty(crit). |
| **SIEM endpoint** | Shipping Falco runtime events + audit logs to a security pipeline | **No endpoint.** Falco itself is also not deployed (Wave 3). |
| **DNS zones / records (automation)** | Auto-managing `*.kortix.com` records for ALBs | **`external-dns` is wedged** (RBAC/IRSA) — DNS records (api-eks, ops, devops, preview) are created **manually** in Cloudflare. Either fix IRSA or formally keep DNS manual + documented (`INFRASTRUCTURE_PLAN.md`). |
| **HashiCorp Vault** (if adopted) | Alternative/complement to ESO + AWS Secrets Manager | **Not adopted.** Current secrets path is ESO + AWS Secrets Manager (working). Vault is optional and only listed because it's a common procurement question. |
| **Argo CD GitHub-org SSO (OAuth App)** | Per-person logins for `ops.kortix.com`, retire shared admin | **Shared `admin` still in use.** OAuth App + `argocd_github_sso_enabled` not yet wired (`infra/GITOPS.md`). |
| **`production` GitHub Environment** | Runtime approval gate on the prod deploy job | **Not created / not referenced** by `deploy-prod.yml`'s `deploy-api` job. Today's gate is the reviewed promote PR into protected `prod`. |

---

## 2. Environment-specific placeholders to fill

Concrete values/config that must be set per environment before the related
feature works.

- **Canary CloudWatch dimensions** — `rollout.analysis.lbArnSuffix` /
  `tgArnSuffix` in `infra/k8s/envs/prod/values.yaml` are set to specific ALB/TG
  suffixes, but `rollout.enabled: false` and `analysis.enabled: false`. Re-verify
  these against the **live** ALB/target-group before enabling the canary at the
  `api.kortix.com` cutover (`infra/GITOPS.md`).
- **`workers.enabled: false`** on prod and dev — flip to `true` **only at
  cutover**, simultaneously with disabling the corresponding ECS service (one
  Postgres leader lease is shared across ECS+EKS). Premature flip = double
  singleton workers.
- **`migrate.enabled: false`** on prod — the Drizzle migrate PreSync hook is off
  until the prod Drizzle ledger is baselined (prod schema was built out-of-band;
  `drizzle.__drizzle_migrations` records 1 of 11). Needs a one-time gated baseline
  (`migration` skill) before enabling.
- **Grafana admin / OIDC + `devops.<domain>` ingress** — Grafana has no real
  admin secret in git and no SSO root-url yet; it serves behind a tunnel today.
  Headlamp's `devops.<domain>` OIDC ingress is "Phase 3" in
  `infra/k8s/argocd/applications/platform-console.yaml`.
- **Working-tree credential files** — `grafana-creds.txt`, `headlamp-token.txt`
  (and ad-hoc `*.sh` DNS scripts in the repo root) should be replaced with
  on-demand `kubectl create token` / SSO and removed from disk
  (`INFRASTRUCTURE_PLAN.md`).

---

## 3. Future improvements (ranked by priority)

| # | Improvement | Wave | Why it matters |
|---|---|---|---|
| **P0** | **Alerting** — Alertmanager on + multi-window multi-burn-rate SLO `PrometheusRule`s → Slack/PagerDuty | 4 | Today there are **0 alerting rules**; prod outages are human-detected. Highest-leverage gap. |
| **P0** | **Velero backup + DR drill** (`scripts/dr-test.sh`) | 3 | No backups of in-cluster state; DR targets are unvalidated (`docs/runbooks/disaster-recovery.md`). |
| **P1** | **Workload hardening** — `securityContext` (non-root, no-priv-esc, drop caps, seccomp, read-only rootfs), ServiceMonitor | 2 | Least-privilege; required for the SLO scrape targets Wave 4 depends on. |
| **P1** | **Cluster guardrails** — Kyverno (audit→enforce), PodSecurityAdmission `restricted`, NetworkPolicy default-deny | 3 | Deny-by-default posture; staged audit-before-enforce. |
| **P1** | **Supply chain** — Trivy image scan gate, syft SBOM, cosign keyless sign/attest, SLSA provenance | 1 | Currently SLSA L0–1; target **L3**. |
| **P2** | **Progressive delivery** — re-enable Argo Rollouts canary + analysis in prod | 5 | Auto-rollback on bad releases once real traffic makes metric analysis meaningful (post-cutover). |
| **P2** | **Tracing + DORA** — OTel → Tempo, DORA dashboard | 4 | No distributed tracing; DORA metrics not measured. |
| **P2** | **Drift cleanup** — retire Lightsail/ECS modules, fix-or-remove `external-dns` | 5 | Eliminate desired-vs-actual drift after EKS cutover. |
| **P3** | **Cost visibility** — OpenCost/Kubecost, spot node pool for dev/preview | 5 | No cost attribution; spot would trim the parallel-run bill. |
| **P3** | **Falco runtime detection** + `staging` env | 3 / 10 | Runtime threat detection; a real pre-prod tier (previews share dev today). |

---

## 4. Tooling to evaluate next quarter

Not committed — candidates to assess, with the question each answers.

- **Backstage (IDP)** — a developer portal / service catalog. Evaluate vs. the
  lighter-weight `docs/ONBOARDING.md` + Headlamp combo; worth it once service
  count grows. (Wave 14 in the scorecard: "No Backstage/devcontainer".)
- **Crossplane** — provision cloud resources via K8s CRDs instead of (or
  alongside) Terraform. Evaluate against the current two-state Terraform model
  (`cluster` + `platform`); only adopt if multi-cloud or self-service infra
  becomes a need.
- **Service mesh / mTLS** (Istio / Linkerd / Cilium) — pod-to-pod mTLS,
  fine-grained traffic policy. Today there's **no mTLS / NetworkPolicy**
  (`INFRASTRUCTURE_PLAN.md` Networking gap). Evaluate Cilium (also covers
  NetworkPolicy + observability) vs. a full mesh — weigh against the small-team
  operational burden.
- **Sigstore policy controller** — admission-time **verification** of cosign
  signatures (the consume side of Wave 1's signing). Evaluate alongside Kyverno
  (Kyverno can also verify image signatures) to avoid two admission controllers.

---

## 5. Remaining compliance gaps

Tooling alone does not equal compliance — several gaps are **process**, not code.

- **SOC 2 Type II — formal change-management *process*.** The technical controls
  exist or are planned (GitOps audit trail, reviewed promote PR, `git revert`
  rollback), but Type II requires a **documented, consistently-followed
  process** evidenced over a period: defined approvers, ticket linkage,
  change-advisory records, and the runtime `production` approval gate actually
  *enforced* (see §1) — not just available. The runbooks here are the start of
  that evidence, not the whole of it.
- **SOC 2 control mapping is informal** — `INFRASTRUCTURE_PLAN.md` has a
  control-mapping table (CC6.x/CC7.x/CC8.x ↔ changes), but it's not yet tracked
  in a GRC tool with per-control evidence. (`drata-compliance.yml` exists as a
  workflow; the underlying controls behind it are still being filled in.)
- **No runtime detection / audit-to-SIEM** — Falco + SIEM shipping (CC7.2) are
  unbuilt (§1, Wave 3). CloudTrail + GuardDuty are present (account-level) but not
  yet wired into the security-event pipeline.
- **No formal SLOs / error budget policy** — burn-rate alerts and SLO definitions
  are Wave 4; without them there's no measured availability commitment (A1.1).
- **DR not drill-validated** — RTO/RPO in `docs/runbooks/disaster-recovery.md`
  are **proposed**, not proven; SOC 2 A1.2/A1.3 expect tested backup/restore.
- **Vulnerability management gate** — no Trivy CRITICAL gate on images yet
  (Wave 1), so there's no enforced SLA on shipping known-vulnerable components
  (CC7.1 / OWASP A06).
