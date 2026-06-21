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

---

## Implementation status — Waves 1–5 (updated 2026-06-20)

Some items above were written before the waves landed and are now done; this
section is the current source of truth.

### Done (committed to `eks-migration`, awaiting push/sync — not yet live)

- **Wave 1** — supply-chain scanning (Trivy fs/image/IaC, Checkov, Hadolint,
  full-history Gitleaks → SARIF), Terraform fmt/validate/tflint + drift, SBOM
  (syft) + cosign sign/attest + SLSA provenance on the dev image, Dockerfile OCI
  labels + HEALTHCHECK, Dependabot terraform+docker, ADRs/runbooks/SECURITY.md.
  The Trivy CRITICAL image gate now exists.
- **Wave 2** — securityContext (non-root, seccomp, no-priv-esc, drop ALL) on the
  API + migrate job; readOnlyRootFilesystem opt-in; ServiceMonitor (gated);
  kortix-dev moved onto the `kortix` Argo project.
- **Wave 3** — Kyverno + 7 ClusterPolicies (AUDIT), opt-in default-deny
  NetworkPolicy, PodSecurityAdmission labels, Velero, Falco. Falco runtime
  detection now exists (sidekick webhook is still a placeholder).
- **Wave 4** — Alertmanager enabled with routing + inhibition; PrometheusRules
  with runbook links; Tempo + OTel collector backend. Alerting now exists
  (Slack/PagerDuty webhooks are placeholders).
- **Wave 5** — OpenCost cost visibility.

### Still gated — decision- or apply-blocked, NOT safe to add as code yet

- **Progressive delivery (canary)** — the chart ships the Rollout + CloudWatch
  AnalysisTemplate, but it was deliberately disabled (commit `0860ec1`) and the
  ECS→EKS cutover isn't final. Enable post-cutover only: `rollout.enabled: true`
  + `rollout.analysis.enabled: true` in `envs/prod/values.yaml`, then fill
  `analysis.lbArnSuffix`/`tgArnSuffix` from the live ALB.
- **Spot node pools (cost)** — add an optional spot node group to `modules/eks`,
  set it in the dev-eks tfvars (non-prod only). Needs `terraform apply`.
- **external-dns** — wedged cluster-wide; DNS is manual today. Fix the IRSA/RBAC
  or remove the controller so desired-state matches reality. Needs apply.
- **Legacy retirement** — `modules/api-host` (Lightsail) + the ECS `dev`/`prod`
  import path can be deleted once the EKS cutover is final (kills the drift).
- **App-side instrumentation** — the Prometheus `/metrics` route is now
  implemented (`lib/metrics.ts`), unblocking ServiceMonitor scraping + API SLO
  burn-rate alerts. The **OTel SDK** for traces into Tempo is still pending.
  Caveat: `/metrics` is served openly — restrict it at the edge (Cloudflare/ALB)
  or add a bearer token before the prod cutover.
- **SSO is LIVE but partly out-of-band** — GitHub login works: Grafana (native
  GitHub OAuth, GitHub-only), Argo CD (GitHub via its Dex, org→admin), Headlamp
  (token dropped — trusts the Cloudflare Access gate via unsafeUseServiceAccountToken).
  CODIFY: Argo's `argocd-cm`/`argocd-rbac-cm`/`argocd-secret` (url, dex github
  connector, RBAC) were live-patched, not in git — fold them into the Terraform
  Argo helm values (`modules/eks/platform`) so a cluster rebuild keeps SSO.
  GitHub OAuth client secrets live in k8s secrets (`grafana-github-oauth`,
  `argocd-secret`) out-of-band — move to External Secrets / Secrets Manager.
- **Headlamp = single-layer auth** — every gated user is the pod SA (cluster-admin)
  on both clusters. Acceptable behind Cloudflare Access + CF-IP-locked ALB; scope
  the SA down (view/edit) if cluster-admin-for-all-gated-users is too broad.
- **Real secret wiring** — replace the Slack/PagerDuty placeholders, the Velero
  S3 bucket + IRSA role, and the Falco sidekick webhook with provisioned values.
- **DR drill** — `scripts/dr-test.sh` + a real Velero restore to prove RTO/RPO.

## Reconciliation sweep (updated 2026-06-21)

State across prod-eu / dev / preview, and the GitOps gaps.

### Works
- **prod-eu:** kortix-api 3/3; gateway all 4 hosts (devops/grafana/argo/cost) 302-gated;
  platform stack Healthy (console, metrics, logs, cost, falco, velero, tracing, otel).
- **dev (us-west-2):** kortix-api 2/2; kortix-dev + kortix-gateway-dev Synced/Healthy.
- **SSO:** Grafana (GitHub-only), Argo (GitHub via Dex), Headlamp (gate-trust).

### Broken / out of sync — needs action
- **Preview envs are DOWN.** The `kortix-previews` ApplicationSet is NOT applied on
  dev-eks; 3 orphaned `kortix-pr-*` namespaces linger (3435, 3455 running; 3446 empty).
  Root cause: the PullRequest generator needs a one-time secret
  `preview-pr-generator-github` (a GitHub token) in dev-eks argocd — absent. FIX:
  create that secret, `kubectl apply` the appset; it then reconciles/prunes the orphans.
- **No app-of-apps applied on EITHER cluster.** `kortix-apps` (app-of-apps.yaml) is
  not present, so every Application (kortix-prod/dev + all platform-*) was applied by
  hand, not GitOps-managed. FIX: land the platform manifests on the tracked branches
  (prod for prod-eu, main for dev) and apply the app-of-apps once → Argo self-manages.
- **platform-console / platform-logs OutOfSync (Healthy):** benign helm-chart runtime
  drift (Headlamp/loki-stack mutate fields). Cosmetic.
- **platform-kyverno OutOfSync (Healthy):** Kyverno CRDs exceed the 256KB client-side
  annotation limit; Replace=true added but Argo still flags drift. Policies ARE loaded
  + enforcing (audit). Cosmetic/known-issue.

### Live infra now codified (this sweep)
- **EBS CSI driver + gp3** → `modules/eks/cluster/ebs-csi.tf` + gp3 manifest. NOTE:
  the live role/addon were created imperatively — `terraform import` them before a
  clean cluster apply or it errors EntityAlreadyExists.

### Still drift (live, not yet owned by code/state)
- **Cloudflare DNS records** (devops/grafana/argo/cost) + the **Access app** —
  created via API/dashboard, not in the `cloudflare-dns` TF module.
- **Argo SSO config** — fully in the TF module code, but TF state lags (helm provider
  won't diff raw values without a release replace); reconciles on next argo chart bump.
- **Out-of-band secrets** (correct pattern, but move to External Secrets eventually):
  grafana-github-oauth, headlamp-kubeconfig, argocd-secret dex, preview generator token.
