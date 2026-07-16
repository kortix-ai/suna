# Kortix API on EKS — prod, staging, and dev

EKS is the **standby** API runtime for prod and dev, and the active runtime for
staging. Public API hosts route through the Cloudflare Worker
(`infra/cloudflare/workers/api-router`, `ACTIVE_BACKEND` per env):

- `api.kortix.com` → `api-ecs-fargate.kortix.com` (ECS ACTIVE since PR #4683; `api-eks.kortix.com` = standby)
- `staging-api.kortix.com` → `staging-api-eks.kortix.com` (EKS active; ECS standby)
- `dev-api.kortix.com` → `dev-api-ecs-fargate.kortix.com` (ECS active; `dev-api-eks.kortix.com` = standby)

Both runtimes are ALWAYS deployed in lockstep by CI (ECS task-defs rendered from
the same Secrets Manager env blob EKS consumes, with `KORTIX_VERSION` stamped so
both report identical versions; EKS via Argo CD GitOps). Do not delete either
side as "legacy" — the standby is only worth having if it is never allowed to
drift, and on prod `deploy-prod.yml`'s `verify-live-version` job enforces that
on every release.

## Why EKS, and why it auto-heals better

The ECS pain (stale containers, APIs not loading) is what Kubernetes' health
model is built to fix. This stack layers self-healing at every level:

| Layer | Mechanism | Recovers from |
| ----- | --------- | ------------- |
| Container | **liveness probe** (`/v1/health`) | a hung / wedged API process — kubelet kills + restarts it |
| Routing | **readiness probe** | a not-yet-ready pod is pulled from the ALB target group until healthy |
| Boot | **startup probe** (≤150s) | slow first boot (schema/migrations) without false liveness kills |
| Deploy | `maxUnavailable: 0` + surge + **preStop drain** | bad releases / mid-deploy request loss |
| Disruption | **PodDisruptionBudget** `minAvailable: 50%` | node drains / rolls dropping capacity |
| Spread | **topologySpreadConstraints** (zone + host) | a node or whole-AZ loss taking all replicas |
| Pods | **HPA** 3→12 (CPU+mem) | load spikes |
| Nodes | **node auto-repair** + **Cluster Autoscaler** | a dead EC2 node; nowhere to place pods |
| Control plane | AWS-managed, multi-AZ (99.95% SLA) | AZ failure |

## Architecture

```
api-eks.kortix.com ─► Cloudflare (proxied, Full-strict)
                       └─► ALB (ACM TLS, :80→:443)         ← AWS LB Controller, from the Ingress
                            └─► EKS pods (kortix-api, 3 AZ) ← managed node group, private subnets
                                 envFrom ─► kortix-api-env  ← External Secrets, from Secrets Manager
                                                               (SAME bundle ECS uses: kortix-prod-env-omifd2)
```

Own isolated VPC (`10.30.0.0/16`, 3 AZ, NAT per AZ) — no overlap/peering with the
ECS VPCs. Redis + Supabase are external (reached over NAT) exactly like ECS, so
no in-VPC datastore wiring is needed.

## Layout

```
infra/terraform/
  modules/
    network/                 # shared (extended with optional EKS subnet tags)
    acm-cloudflare/          # shared (cert for api-eks.kortix.com)
    eks/
      cluster/               # control plane + managed node group + addons + OIDC
      platform/              # ALB controller, External Secrets, external-dns,
                             #   metrics-server, cluster-autoscaler (Helm + IRSA)
      irsa/                  # reusable IRSA-role helper
  environments/prod-eks/
    cluster/                 # state 1: AWS-only (VPC, EKS, ACM, IAM/IRSA, access)
    platform/                # state 2: in-cluster controllers + app namespace
infra/k8s/charts/kortix-api/ # the app workload (reconciled by Argo CD)
.github/workflows/deploy-dev.yml / deploy-staging.yml / deploy-prod.yml
```

Two Terraform states on purpose: the kubernetes/helm providers can't be
configured until the cluster endpoint exists, so the cluster (`cluster`) and the
in-cluster controllers (`platform`) are separate states. The app itself is a
Helm chart that Argo CD reconciles from `infra/k8s/envs/<env>/values.yaml` —
Terraform owns infra, GitOps owns the app.

## Bring-up (one time)

Prereqs: `terraform`, `kubectl`, `helm`, `aws` CLIs; AWS creds for account
`935064898258`; a Cloudflare API token with DNS:Edit on `kortix.com` and the zone
ID. The state bucket/lock table already exist (shared with ECS).

```bash
export TF_VAR_cloudflare_api_token=...   # DNS:Edit on kortix.com
export TF_VAR_cloudflare_zone_id=...

# 1) Cluster layer (VPC, EKS, node group, ACM cert, IAM/IRSA, CI access).
cd infra/terraform/environments/prod-eks/cluster
cp terraform.tfvars.example terraform.tfvars   # review; defaults are prod-ready
terraform init
terraform apply                                 # ~15-20 min (control plane + nodes)

# 2) Platform layer (controllers + app namespace). Reads the cluster's state.
#    The Helm provider reads the LOCAL Helm repo cache, so seed it once on a
#    fresh machine (otherwise: "no cached repo found ... eks-index.yaml"):
helm repo add eks https://aws.github.io/eks-charts
helm repo add external-secrets https://charts.external-secrets.io
helm repo add external-dns https://kubernetes-sigs.github.io/external-dns/
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo add autoscaler https://kubernetes.github.io/autoscaler
helm repo update
cd ../platform
terraform init
terraform apply                                 # ~5 min (Helm releases)

# 3) First app deploy (Argo CD / CI owns this automatically afterward).
cd ../cluster
ROLE_ARN=$(terraform output -raw app_irsa_role_arn)
CERT_ARN=$(terraform output -raw acm_certificate_arn)
aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2
helm upgrade --install kortix-api ../../../k8s/charts/kortix-api \
  --namespace kortix-prod \
  --set image.tag="$(tr -d '[:space:]' < ../../../../VERSION)" \
  --set kortixVersion="$(tr -d '[:space:]' < ../../../../VERSION)" \
  --set serviceAccount.roleArn="$ROLE_ARN" \
  --set ingress.host=api-eks.kortix.com \
  --set ingress.certificateArn="$CERT_ARN" \
  --wait --timeout 10m

curl -fsS https://api-eks.kortix.com/v1/health
```

After bring-up, a push to `main` deploys dev via `deploy-dev.yml`; a PR merged
into `staging` deploys staging via `deploy-staging.yml`; a reviewed promote PR
merged to `prod` deploys prod via `deploy-prod.yml`.

## Switch-back / coexistence

- **ECS Fargate** → `api-ecs-fargate.kortix.com` /
  `dev-api-ecs-fargate.kortix.com` (ACTIVE for prod + dev since PR #4683).
- **EKS** → `api-eks.kortix.com` / `dev-api-eks.kortix.com` (standby) and
  `staging-api-eks.kortix.com` (active for staging).
- Keep BOTH origins permanently reachable (the ecs-api module supports extra
  hostnames):

  ```hcl
  # infra/terraform/environments/prod/terraform.tfvars
  extra_api_hostnames = ["api-ecs-fargate.kortix.com"]
  ```
  then `terraform apply` in `environments/prod` (adds an ACM SAN + proxied CNAME;
  does not disturb anything else).
- **`api.kortix.com` / `staging-api.kortix.com` / `dev-api.kortix.com`** flip via the Cloudflare Worker
  `ACTIVE_BACKEND` var (see `infra/CICD.md` and
  `infra/cloudflare/workers/api-router`): `ecs-fargate` is active on prod/dev
  and `eks` is the rollback/standby (staging is the inverse) — sub-second, no
  DNS surgery.

Discontinue either runtime only after an explicit decision; until then CI keeps
both origins deployed and healthy on every roll.

## Operations

```bash
aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2

kubectl -n kortix-prod get pods -o wide          # placement across AZs/nodes
kubectl -n kortix-prod rollout status deploy/kortix-api
kubectl -n kortix-prod logs -l app.kubernetes.io/name=kortix-api -f
kubectl -n kortix-prod get hpa,pdb
kubectl -n kortix-prod get externalsecret         # SecretSynced=True when healthy
kubectl -n kortix-prod get ingress                # ADDRESS = the ALB hostname

# Rollback to a previous release:
git revert <prod values/release commit>   # preferred GitOps rollback
# or, for emergency operator rollback: argocd app rollback kortix-prod <REVISION>
```

## Teardown (if abandoning EKS)

```bash
helm -n kortix-prod uninstall kortix-api
cd infra/terraform/environments/prod-eks/platform && terraform destroy
cd ../cluster && terraform destroy
```

ECS and the shared modules are untouched by this.

## Cost (rough, parallel run)

EKS control plane ~$73/mo · 3× `m6i.large` on-demand ~$190/mo · 3× NAT ~$98/mo ·
ALB ~$20/mo → **~$380/mo** at the 3-AZ floor (scales with traffic). Drop to 2 AZs
or smaller/Spot nodes to trim while validating.
