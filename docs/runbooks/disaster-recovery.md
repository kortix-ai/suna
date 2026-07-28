# Runbook: Disaster Recovery

What we do if a cluster, region, or the GitOps control plane is lost. The
load-bearing fact: **the API tier is stateless**. The database is external
(**Supabase**), Redis is external, and secrets live in **AWS Secrets Manager**.
So **cluster loss ≠ data loss** — DR is mostly a *rebuild-and-reconnect* exercise,
not a data-restore one.

| Cluster | Region | Namespace | Argo app / branch |
|---|---|---|---|
| `kortix-prod-eks` | eu-west-2 | `kortix-prod` | `kortix-prod` / `prod` |
| `kortix-dev-eks` | us-west-2 | `kortix-dev` | `kortix-dev` / `main` |

---

## RTO / RPO targets

> **Status: PROPOSED** — not yet contractually committed or drill-validated.
> Ratify after the first `scripts/dr-test.sh` drill (see below).

| Scenario | RTO (proposed) | RPO (proposed) | Why |
|---|---|---|---|
| Single pod / node loss | seconds–minutes | 0 | Self-heals: probes, PDB, topology spread, HPA, cluster-autoscaler, node auto-repair (`infra/EKS.md`). Not a "disaster". |
| Bad release | < 15 min | 0 | `git revert` / `argocd app rollback` (`docs/runbooks/rollback-procedure.md`). |
| **Full cluster loss** (prod) | **1 h** | **0** for app data (Supabase external); **24 h** for in-cluster K8s state | Rebuild from Terraform + re-sync GitOps; restore the latest daily Velero backup. |
| Region loss (eu-west-2) | 2–4 h | 0 app data | Rebuild the cluster stack in an alternate region (Terraform is region-parameterized); repoint DNS. Supabase/Secrets Manager region-independent. |

**Why RPO ≈ 0 for app data:** Supabase owns all persistent customer data and is
backed up by Supabase, independent of EKS. The cluster holds **no source of
record** — every K8s object is reproducible from Terraform + the git-tracked
manifests. The 24h RPO line applies only to *in-cluster* state (e.g. Grafana
dashboards/PVCs, and Loki logs).

---

## Full cluster rebuild from Terraform

The cluster is two Terraform states **on purpose** (the kubernetes/helm
providers can't be configured until the cluster endpoint exists): `cluster`
(AWS-only: VPC, EKS, node group, ACM, IAM/IRSA, CI access) then `platform`
(in-cluster controllers + app namespace). See `infra/EKS.md`. State lives in S3
(`kortix-terraform-state` + DynamoDB locks) and survives the cluster.

```bash
export TF_VAR_cloudflare_api_token=...   # DNS:Edit on kortix.com
export TF_VAR_cloudflare_zone_id=...

# 1) Cluster layer — control plane + managed node group + addons + OIDC/IRSA.
cd infra/terraform/environments/prod-eks/cluster
terraform init
terraform apply                          # ~15–20 min

# 2) Platform layer — ALB controller, External Secrets, metrics-server,
#    cluster-autoscaler, app namespace. Seed the Helm repo cache first on a
#    fresh machine (else: "no cached repo found ... eks-index.yaml").
helm repo add eks https://aws.github.io/eks-charts
helm repo add external-secrets https://charts.external-secrets.io
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update
cd ../platform
terraform init
terraform apply                          # ~5 min (Helm releases)

aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2
```

For dev, use `infra/terraform/environments/dev-eks/{cluster,platform}` (region
`us-west-2`).

### Re-bootstrap Argo CD → app-of-apps re-syncs everything

Argo CD + Rollouts are installed by the platform Terraform
(`modules/eks/platform`). Then re-apply the GitOps root and **everything else
self-assembles** from git (`infra/GITOPS.md`):

```bash
# 1) Re-register the repo deploy key as an Argo CD repo credential (read-only).
# 2) Apply the AppProject + the app-of-apps root.
kubectl apply -f infra/k8s/argocd/project.yaml
kubectl apply -f infra/k8s/argocd/project-platform.yaml
kubectl apply -f infra/k8s/argocd/app-of-apps.yaml
#    app-of-apps syncs infra/k8s/argocd/applications/* →
#      kortix-prod (the API, from envs/prod/values.yaml @ prod),
#      kortix-platform-metrics (Grafana/Prometheus), kortix-platform-logs (Loki),
#      kortix-platform-console (Headlamp).

argocd app list                          # all apps appear and sync
argocd app get kortix-prod               # → Synced / Healthy
```

Because secrets are external (ESO pulls the `kortix-prod-env` bundle from Secrets
Manager in eu-west-2 → `kortix-api-env`) and the DB is external, the rebuilt
pods reconnect to the live data plane with no restore step.

### Verify the rebuild

```bash
kubectl -n kortix-prod get pods -o wide              # 3 replicas across 3 AZs
kubectl -n kortix-prod get externalsecret            # SecretSynced=True
kubectl -n kortix-prod get ingress                   # ADDRESS = new ALB hostname
# DNS is manual (external-dns is wedged): update the proxied CNAME for
# api-eks.kortix.com → the new ALB hostname (Cloudflare).
curl -fsS https://api-eks.kortix.com/v1/health | jq '{version,status}'
```

> **DNS caveat:** `external-dns` is currently wedged, so cluster rebuilds get a
> **new ALB hostname** and the Cloudflare CNAME must be repointed **manually**
> (`infra/INFRASTRUCTURE_PLAN.md`). Fastest customer-facing recovery for an
> origin outage is the Cloudflare Worker `api-kortix-router` `ACTIVE_BACKEND`
> switch (flip prod away from `eks` to `ecs-fargate` while EKS rebuilds —
> `infra/CICD.md`).

---

## Velero backup and restore

Velero runs in `kortix-prod-eks`. The `daily-all-namespaces` schedule starts at
`03:00 UTC`. Each backup has a `720h` TTL. The
`s3://kortix-velero-backups` bucket is in `eu-west-2`. Terraform enables S3
versioning, KMS encryption, and a 35-day lifecycle expiration.

Customer application data remains outside EKS. Velero protects Kubernetes
objects and EBS volume snapshots only.

Validation on 2026-07-27 produced these results:

- `BackupStorageLocation/default` reported `Available`.
- `velero-readiness-full-20260727t2235z` backed up `1,844/1,844` objects.
- The full backup reported `0` errors and `0` warnings.
- All `5/5` EBS snapshots reached `completed` and `100%`.
- A scoped restore recovered the expected ConfigMap value in a mapped
  throwaway namespace.

```bash
CTX=kortix-prod-eks

kubectl --context "$CTX" -n velero get backupstoragelocation default
kubectl --context "$CTX" -n velero get schedule
kubectl --context "$CTX" -n velero get backup
```

The backup storage location must report `Available`. Each scheduled backup must
reach `Completed`.

### Scoped restore drill

Create one marker object. Back up only its source namespace. Restore it into a
different namespace.

```bash
CTX=kortix-prod-eks
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SOURCE="velero-drill-source-${STAMP}"
RESTORED="velero-drill-restored-${STAMP}"
BACKUP="velero-drill-${STAMP}"
RESTORE="velero-drill-restore-${STAMP}"

kubectl --context "$CTX" create namespace "$SOURCE"
kubectl --context "$CTX" -n "$SOURCE" create configmap recovery-marker \
  --from-literal=expected="$STAMP"

kubectl --context "$CTX" -n velero apply -f - <<EOF
apiVersion: velero.io/v1
kind: Backup
metadata:
  name: ${BACKUP}
spec:
  includedNamespaces:
    - ${SOURCE}
  storageLocation: default
  ttl: 24h0m0s
EOF

kubectl --context "$CTX" -n velero wait \
  --for=jsonpath='{.status.phase}'=Completed "backup/${BACKUP}" --timeout=10m

kubectl --context "$CTX" -n velero apply -f - <<EOF
apiVersion: velero.io/v1
kind: Restore
metadata:
  name: ${RESTORE}
spec:
  backupName: ${BACKUP}
  namespaceMapping:
    ${SOURCE}: ${RESTORED}
EOF

kubectl --context "$CTX" -n velero wait \
  --for=jsonpath='{.status.phase}'=Completed "restore/${RESTORE}" --timeout=10m
test "$(kubectl --context "$CTX" -n "$RESTORED" get configmap recovery-marker \
  -o jsonpath='{.data.expected}')" = "$STAMP"
```

Delete both drill namespaces after the assertion. Do not restore a drill over a
live namespace or a live persistent volume.

---

## DR drill — `scripts/dr-test.sh` — TO BE ADDED

A scripted, scheduled drill will prove the full cluster rebuild. The scoped
Velero restore procedure above provides the current backup and restore check.

> **Status: TO BE ADDED.** `scripts/dr-test.sh` does **not exist yet**
> (`scripts/` currently has `setup-env.sh`, `dev-local.sh`, etc., not
> `dr-test.sh`). It is called out in `infra/INFRASTRUCTURE_PLAN.md` Wave 3
> validation ("`velero backup` + test restore in a throwaway namespace
> (`scripts/dr-test.sh`)"). When added, it should:

1. Run the scoped Velero restore procedure above.
2. Tear both throwaway namespaces down.
3. Stand up a scratch cluster from Terraform, re-bootstrap Argo, assert
   `kortix-*` syncs Healthy, and record the measured RTO to ratify the proposed
   targets above.

**Cadence (proposed):** quarterly, results logged to confirm or revise RTO/RPO.
