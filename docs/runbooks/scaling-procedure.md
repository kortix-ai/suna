# Runbook: Scaling Procedure

Three layers of scaling, from fastest/most-automatic to slowest/most-deliberate:

1. **HPA** — scales **pods** on CPU/memory (per-env values; GitOps).
2. **Cluster Autoscaler** — scales **nodes** to fit unschedulable pods
   (automatic, installed by platform Terraform).
3. **Node group resize** — changes the node group floor/ceiling/instance type
   via **Terraform** (`modules/eks`), the deliberate capacity lever.

Most of the time you change nothing — HPA + cluster-autoscaler absorb load. You
touch this runbook to change *limits*, not to react minute-to-minute.

| Env | Replicas | HPA min→max | HPA targets | Pod resources (req=lim mem) |
|---|---|---|---|---|
| prod | floor 3 | **3 → 12** | CPU 60% / mem 60% | 500m–1 CPU / **2Gi** (Guaranteed) |
| staging | floor 2 | **2 → 4** | CPU 60% / mem 60% | 500m–1 CPU / 1Gi |
| dev | floor 1 | **1 → 2** | chart default | 250m–1 CPU / 512Mi |
| preview | 1 | **HPA off** | — | 100m–500m / 256–512Mi |

Sources: `infra/k8s/envs/{prod,staging,dev,preview}/values.yaml`,
`infra/k8s/charts/kortix-api/templates/hpa.yaml`, node group in
`infra/terraform/modules/eks/cluster` +
`infra/terraform/environments/prod-eks/cluster/terraform.tfvars`.

---

## 1. Pod scaling — HPA (per-env values, GitOps)

The HPA (`templates/hpa.yaml`, `autoscaling/v2`) scales the Deployment on
**average CPU and memory utilization**. Behavior is asymmetric on purpose: scale
**up fast** (`stabilizationWindowSeconds: 30`), scale **in slow**
(`stabilizationWindowSeconds: 300`) so a brief dip doesn't drop capacity under
real load.

Prod (`infra/k8s/envs/prod/values.yaml`):

```yaml
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 12
  targetCPUUtilizationPercentage: 60     # earlier scale-out so HPA adds a pod
  targetMemoryUtilizationPercentage: 60  # BEFORE pods approach their ceiling
resources:
  requests: { cpu: "500m", memory: "2Gi" }   # request==limit on memory →
  limits:   { cpu: "1",    memory: "2Gi" }    # Guaranteed QoS, no per-pod OOM
```

> **HPA scales on the average; OOM is per-pod and instant.** The app sits ~840Mi
> and spiked past the old 1Gi limit → OOMKilled (exit 137) → random restarts.
> The fix was **both** levers: HPA targets at 60% (proactive) **and** a real
> per-pod ceiling (`2Gi`, request==limit so QoS is Guaranteed). If you see
> OOMKills, raise `resources.limits.memory`, not just the HPA target.

**Change the limits (the GitOps way):** edit the env values, PR, merge. For
prod the change rides the staging → promote → `prod` flow; for staging it lands
on `staging`, and for dev it lands on `main`.

```bash
# Edit infra/k8s/envs/prod/values.yaml (e.g. maxReplicas 12 → 16), commit, PR.
# Argo CD reconciles the new HPA bounds. Verify:
aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2
kubectl -n kortix-prod get hpa kortix-api -w     # MINPODS/MAXPODS/REPLICAS/TARGETS
kubectl -n kortix-prod top pods                  # actual CPU/mem vs the 60% target
```

**Emergency manual override (revert via git after):** in a SEV you can bump the
floor immediately, but Argo `selfHeal` will revert it to the git value on the
next reconcile — so land the values PR too, or it bounces back.

```bash
kubectl -n kortix-prod scale deploy/kortix-api --replicas=8   # stop-gap only
```

> HPA pinned at `maxReplicas` with latency still high = you're out of *pod*
> headroom → raise `maxReplicas` (values) and check node capacity (below).

---

## 2. Node scaling — Cluster Autoscaler (automatic)

The **Cluster Autoscaler** (installed by `modules/eks/platform`) watches for
**Pending/unschedulable** pods and grows the managed node group; it consolidates
and scales nodes back in when they're underutilized. No action needed in the
common case — when the HPA adds pods that don't fit, CA adds a node.

The node group's `desired_size` is **owned by the autoscaler at runtime** —
Terraform deliberately `ignore_changes = [scaling_config[0].desired_size]`
(`modules/eks/cluster/main.tf`), so the autoscaler and Terraform don't fight.

Diagnose node-side pressure:

```bash
kubectl get nodes -o wide
kubectl -n kortix-prod get pods -o wide | grep -i pending     # unschedulable?
kubectl -n kortix-prod describe pod <pending-pod> | sed -n '/Events/,$p'  # "Insufficient cpu/memory"
kubectl -n kube-system logs deploy/cluster-autoscaler-aws-cluster-autoscaler --tail=100
```

If pods are Pending and CA isn't adding nodes, you've hit the node group's
**`max_size` ceiling** → raise it via Terraform (next section).

---

## 3. Node group resize — Terraform (`modules/eks`)

The deliberate capacity lever: floor, ceiling, and **instance type**. The node
group is defined in `infra/terraform/modules/eks/cluster` and parameterized per
env in `infra/terraform/environments/<env>/cluster/terraform.tfvars`.

Prod defaults (`prod-eks/cluster/terraform.tfvars`):

```hcl
node_instance_types = ["m6i.large"]
node_desired_size   = 3   # initial; autoscaler owns it at runtime thereafter
node_min_size       = 3
node_max_size       = 9
```

(3× `m6i.large` is the 3-AZ floor — `infra/EKS.md` cost note.)

**Raise the ceiling / floor:**

```bash
# Edit node_max_size (and/or node_min_size) in the env's terraform.tfvars.
cd infra/terraform/environments/prod-eks/cluster
terraform init
terraform plan      # confirm ONLY the node group max/min changes
terraform apply
```

**Resize the instance type (vertical):** change `node_instance_types`. This
replaces nodes — EKS managed node groups roll them respecting
`node_max_unavailable_percentage` (a variable on the module), and the PDB
(`minAvailable: 50%`) + `maxUnavailable: 0` on the Deployment keep the API up
during the roll. Stage on **dev-eks first**.

```bash
kubectl get nodes -w   # watch old nodes cordon/drain and new ones join Ready
kubectl -n kortix-prod get pods -o wide   # pods reschedule, stay Available
```

> **Don't manually set `desired_size`** in tfvars to "scale" — it's
> `ignore_changes`'d so the autoscaler owns it. `min`/`max` are the real knobs;
> the autoscaler moves `desired` between them.

> **Spot pool — planned.** A spot node group for dev/preview is **Wave 5** in
> `infra/INFRASTRUCTURE_PLAN.md` (`modules/eks` + tfvars), not yet present.

---

## Decision guide

| Symptom | Layer | Action |
|---|---|---|
| CPU/mem high, replicas < max | HPA | Wait — HPA scales up (30s window). |
| HPA pinned at `maxReplicas`, latency high | HPA values | Raise `maxReplicas` in env values (PR). |
| Per-pod `OOMKilled` (exit 137) | Pod resources | Raise `resources.limits.memory` in env values (PR). |
| Pods Pending, "Insufficient cpu/memory" | Cluster Autoscaler / node group | CA should add a node; if at `node_max_size`, raise it via Terraform. |
| Nodes consistently saturated / under-sized | Node group | Bump `node_max_size` or change `node_instance_types` via Terraform (dev-first). |
| Anticipated traffic event | HPA + node group | Pre-raise `minReplicas` + `node_min_size` ahead of time via values/tfvars PRs. |
