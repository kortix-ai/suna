# Kortix API on EKS (prod) — `api-eks.kortix.com`

A production EKS stack for the Kortix API that runs **in parallel** with the
existing ECS prod stack. Nothing here touches ECS: dev stays on ECS, prod ECS
keeps serving `api-prod` / `api.kortix.com`, and EKS comes up under
`api-eks.kortix.com`. Once EKS is proven in prod, `api.kortix.com` is flipped to
it via the existing Cloudflare Worker switch — instantly and reversibly.

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
infra/k8s/charts/kortix-api/ # the app workload (deployed by CI / helm)
.github/workflows/deploy-prod-eks.yml
```

Two Terraform states on purpose: the kubernetes/helm providers can't be
configured until the cluster endpoint exists, so the cluster (`cluster`) and the
in-cluster controllers (`platform`) are separate states. The app itself is a
Helm chart that CI rolls — Terraform owns infra, CI owns the app, mirroring ECS.

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

# 3) First app deploy (CI does this automatically on every prod push afterward).
cd ../cluster
ROLE_ARN=$(terraform output -raw app_irsa_role_arn)
CERT_ARN=$(terraform output -raw acm_certificate_arn)
aws eks update-kubeconfig --name kortix-prod-eks --region us-west-2
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

After bring-up, every push to `prod` deploys to EKS automatically via
`deploy-prod-eks.yml` (parallel to the ECS pipeline; it no-ops until the cluster
exists).

## Switch-back / coexistence

- **EKS** → `api-eks.kortix.com` (this stack).
- **ECS** → keep it permanently reachable at `api-ecs.kortix.com` by adding that
  host to ECS prod's `extra_api_hostnames` (the module already supports it):

  ```hcl
  # infra/terraform/environments/prod/terraform.tfvars
  extra_api_hostnames = ["api-ecs.kortix.com"]
  ```
  then `terraform apply` in `environments/prod` (adds an ACM SAN + proxied CNAME;
  does not disturb anything else).
- **`api.kortix.com`** keeps flipping via the Cloudflare Worker `ACTIVE_BACKEND`
  var (see `infra/CICD.md`): add an `eks → api-eks.kortix.com` case next to the
  existing `ecs-fargate → api-prod.kortix.com`. Flip to `eks` to cut over, back
  to `ecs-fargate` to roll back — sub-second, no DNS surgery.

Discontinue ECS only after EKS is proven; until then both serve in parallel.

## Operations

```bash
aws eks update-kubeconfig --name kortix-prod-eks --region us-west-2

kubectl -n kortix-prod get pods -o wide          # placement across AZs/nodes
kubectl -n kortix-prod rollout status deploy/kortix-api
kubectl -n kortix-prod logs -l app.kubernetes.io/name=kortix-api -f
kubectl -n kortix-prod get hpa,pdb
kubectl -n kortix-prod get externalsecret         # SecretSynced=True when healthy
kubectl -n kortix-prod get ingress                # ADDRESS = the ALB hostname

# Rollback to a previous release:
helm -n kortix-prod history kortix-api
helm -n kortix-prod rollback kortix-api <REVISION>
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
