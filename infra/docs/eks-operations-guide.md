# Kortix EKS Operations Guide

Everything you need to know about how our Kubernetes setup works, how to monitor, scale, and what happens when things go wrong.

---

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [How Our K8s Setup Works](#how-our-k8s-setup-works)
3. [What Runs Where](#what-runs-where)
4. [How Deployments Work](#how-deployments-work)
5. [How Scaling Works](#how-scaling-works)
6. [Health Checks (How K8s Knows If Your App Is Alive)](#health-checks)
7. [What Happens When Things Break](#what-happens-when-things-break)
8. [Monitoring](#monitoring)
9. [Common Operations](#common-operations)
10. [Secrets Management](#secrets-management)
11. [Troubleshooting](#troubleshooting)

---

## The Big Picture

Production runs on three targets simultaneously:

```
User request
  → Cloudflare DNS (api-eks.kortix.com)
  → AWS Application Load Balancer (ALB)
  → EKS cluster (suna-eks)          ← this is the primary
  → Your app pods

We also have:
  → Lightsail instance               ← legacy, still running
  → ECS cluster (suna-ecs)           ← legacy, still running
```

The EKS cluster is the main production target. Lightsail and ECS are still deployed to, but EKS handles the real traffic through `api-eks.kortix.com`.

**Region:** `us-west-2` (Oregon)

---

## How Our K8s Setup Works

If you're new to Kubernetes, here's the mental model. Think of it like a restaurant:

- **Cluster** = the restaurant building (EKS manages this for us)
- **Nodes** = the kitchen stations (EC2 machines, currently `c7i.2xlarge` — 8 vCPUs, 16 GB RAM each)
- **Pods** = the chefs (each pod runs one copy of our backend app)
- **Deployment** = the recipe card that says "always have 4 chefs working"
- **Service** = the front desk that routes customers (requests) to available chefs
- **Ingress** = the restaurant's street address (connects the ALB to our service)
- **HPA** = the manager who hires more chefs when it gets busy

### The actual resources in our cluster

```
Cluster: suna-eks (EKS v1.31)
├── Node Group: suna-api-nodes
│   ├── Instance type: c7i.2xlarge (8 vCPU, 16 GB RAM)
│   ├── Min nodes: 2
│   ├── Max nodes: 8
│   └── Desired: 3
│
├── Namespace: suna
│   ├── Deployment: suna-api (our backend app)
│   │   ├── Base replicas: 4 pods
│   │   ├── Each pod: 500m-1500m CPU, 2Gi-3Gi memory
│   │   └── Each pod runs 2 Gunicorn workers
│   │
│   ├── Service: suna-api (ClusterIP, routes traffic to pods)
│   ├── HPA: suna-api (autoscales 4-15 pods based on CPU)
│   ├── PDB: suna-api (keeps at least 50% of pods alive during disruptions)
│   ├── Ingress: suna-api (ALB → internet-facing)
│   └── Secret: suna-env (all the env vars from Secrets Manager)
│
├── Namespace: kube-system
│   ├── AWS Load Balancer Controller (manages the ALB)
│   ├── Cluster Autoscaler (adds/removes nodes)
│   ├── CloudWatch Observability addon (sends metrics to CloudWatch)
│   └── Better Stack Collector (sends logs/metrics to Better Stack)
│
└── Namespace: default
    └── Better Stack Collector DaemonSet
```

### What each pod gets

Every pod gets these environment variables and resources:

| Setting | Value |
|---------|-------|
| CPU request | 500m (half a core) — guaranteed minimum |
| CPU limit | 1500m (1.5 cores) — hard ceiling |
| Memory request | 2Gi — guaranteed minimum |
| Memory limit | 3Gi — if it uses more, K8s kills it (OOMKill) |
| Workers | 2 Gunicorn workers per pod |
| Port | 8000 |
| Health check | `/v1/health-docker` |

**What "request" vs "limit" means:**
- **Request** = "I need at least this much." K8s won't schedule the pod on a node unless the node has this much free.
- **Limit** = "Don't ever use more than this." If the pod tries to use more memory than the limit, K8s kills it. If it tries to use more CPU, K8s throttles it (slows it down but doesn't kill it).

---

## What Runs Where

### Infrastructure-as-Code (Pulumi)

All the K8s infrastructure is defined in code using Pulumi (TypeScript). You'll find it in `infra/`:

```
infra/
├── environments/
│   ├── prod/index.ts        ← production stack (EKS + monitoring)
│   ├── dev/index.ts          ← dev (Lightsail only)
│   └── staging/index.ts      ← staging (Lightsail only)
│
├── modules/
│   ├── kubernetes/
│   │   ├── cluster.ts        ← EKS cluster + node groups
│   │   ├── workload.ts       ← Deployment, Service, HPA, PDB, Ingress
│   │   ├── autoscaler.ts     ← Cluster Autoscaler (Helm chart)
│   │   ├── iam.ts            ← IAM roles for nodes, ALB controller, autoscaler
│   │   └── types.ts          ← TypeScript interfaces
│   │
│   ├── monitoring/
│   │   ├── alarms.ts         ← CloudWatch alarms + dashboard
│   │   └── types.ts
│   │
│   └── lightsail/
│       ├── instance.ts       ← Lightsail for dev/staging
│       └── types.ts
```

If you want to change the number of pods, node types, memory limits, etc., edit the config values in `environments/prod/index.ts` and run `pulumi up`.

### CI/CD Pipeline

Defined in `.github/workflows/docker-build.yml`. When you push to the `PRODUCTION` branch:

```
Push to PRODUCTION
  → Build Docker image
  → Push to GHCR with tags `:prod` and `:<commit-sha>`
  → Deploy to Lightsail (SSH + docker compose)    } These three
  → Deploy to ECS (aws ecs update-service)         } run in
  → Deploy to EKS (kubectl set image)              } parallel
```

The EKS deploy step:
1. Authenticates to AWS using OIDC (no stored credentials)
2. Gets kubeconfig for the cluster
3. Syncs secrets from AWS Secrets Manager → K8s secret
4. Updates the deployment image to the new SHA tag
5. Waits for the rollout to complete (up to 5 minutes)
6. Prints the running pods and current image for verification

---

## How Deployments Work

### Rolling Updates

When a new image is deployed, K8s doesn't kill all pods and start new ones. It does a **rolling update**:

```
Step 1: Start 1 new pod with the new image
Step 2: Wait until the new pod passes health checks
Step 3: Remove 1 old pod
Step 4: Repeat until all pods are running the new image
```

Our config:
- `maxUnavailable: 0` — never kill an old pod before a new one is ready (zero downtime)
- `maxSurge: 1` — only create 1 extra pod at a time (don't overwhelm the nodes)

So if you have 4 pods, during deployment you'll briefly have 5 (4 old + 1 new), then 4 (3 old + 1 new), etc.

### Graceful Shutdown

When a pod is being removed:
1. K8s sends it a SIGTERM signal ("please shut down")
2. The pod gets 120 seconds (`terminationGracePeriodSeconds`) to finish in-flight requests
3. After 120s, K8s sends SIGKILL ("you're done, goodbye")

This means long-running agent executions get up to 2 minutes to complete during deployments.

### Pod Distribution

We use `topologySpreadConstraints` to spread pods across nodes evenly. If you have 4 pods and 2 nodes, each node gets 2 pods. This way, if one node dies, you don't lose all your pods.

---

## How Scaling Works

There are two levels of autoscaling, and they work together:

### Level 1: Pod Autoscaling (HPA)

The **Horizontal Pod Autoscaler** watches CPU usage across your pods and adds/removes pods to keep CPU around the target.

| Setting | Value |
|---------|-------|
| Min pods | 4 |
| Max pods | 15 |
| CPU target | 70% average utilization |
| Scale up speed | Can double pods every 60 seconds |
| Scale down speed | Removes at most 25% of pods every 60 seconds |
| Scale down cooldown | Waits 5 minutes before scaling down (prevents flapping) |
| Scale up cooldown | Only waits 30 seconds before scaling up (fast reaction) |

**Example:** If your 4 pods are averaging 85% CPU, HPA will add more pods. If they drop to 40% CPU, HPA will (after 5 minutes) remove some pods back to the minimum of 4.

### Level 2: Node Autoscaling (Cluster Autoscaler)

If HPA wants to add pods but there's no room on existing nodes, the **Cluster Autoscaler** adds new EC2 nodes.

| Setting | Value |
|---------|-------|
| Min nodes | 2 |
| Max nodes | 8 |
| Scale down threshold | Node is underutilized if < 65% used |
| Scale down delay | Waits 5 minutes after adding a node before considering removal |
| Scale down wait | Node must be underutilized for 5 minutes straight |
| Strategy | "least-waste" — picks the node size that wastes the least resources |

**How they work together:**

```
Traffic spikes
  → Pods CPU goes above 70%
  → HPA: "I need more pods!"
  → HPA creates new pods
  → If nodes are full, new pods are "Pending" (can't be scheduled)
  → Cluster Autoscaler sees Pending pods
  → Cluster Autoscaler: "I'll add a node!"
  → New EC2 node joins the cluster (~3-5 minutes)
  → Pending pods get scheduled on the new node

Traffic drops
  → Pods CPU drops below target
  → HPA: "Too many pods, removing some" (after 5 min cooldown)
  → Pods get removed
  → Some nodes become underutilized (< 65% used)
  → Cluster Autoscaler: "This node is mostly empty, removing it" (after 5 min)
  → Pods on that node get moved to other nodes first
  → Empty node is terminated
```

### PodDisruptionBudget (PDB)

During voluntary disruptions (node drain, cluster upgrade, autoscaler removing a node), the PDB guarantees at least **50% of pods** stay running. So if you have 4 pods, at least 2 must be alive during any maintenance operation.

---

## Health Checks

K8s constantly checks if your app is healthy using three probes. All three hit the same endpoint (`/v1/health-docker` on port 8000) but serve different purposes:

### Startup Probe — "Has the app finished booting?"

| Setting | Value |
|---------|-------|
| Initial delay | 10 seconds |
| Check interval | Every 10 seconds |
| Max failures | 12 |
| Timeout per check | 5 seconds |

This gives the app up to **130 seconds** (10s delay + 12 x 10s) to start. During this time, liveness and readiness probes are paused. This is important because our app takes a while to load models, connect to databases, etc.

### Readiness Probe — "Can this pod handle traffic right now?"

| Setting | Value |
|---------|-------|
| Initial delay | 15 seconds |
| Check interval | Every 10 seconds |
| Max failures | 3 |
| Timeout per check | 5 seconds |

If this fails 3 times in a row, K8s **stops sending traffic** to this pod (removes it from the load balancer). The pod stays alive — it just doesn't get requests. Once it starts passing again, traffic resumes.

Think of it as: "This pod is alive but busy/unhealthy, give it a break."

### Liveness Probe — "Is this pod stuck/dead?"

| Setting | Value |
|---------|-------|
| Initial delay | 30 seconds |
| Check interval | Every 30 seconds |
| Max failures | 3 |
| Timeout per check | 5 seconds |

If this fails 3 times in a row, K8s **kills and restarts** the pod. This catches deadlocks, stuck event loops, memory corruption — cases where the process is technically running but completely broken.

Think of it as: "This pod is dead inside, restart it."

---

## What Happens When Things Break

### Pod crashes (OOMKill, unhandled exception, etc.)

```
Pod crashes
  → K8s immediately starts a new one (restartPolicy: Always)
  → Other pods keep serving traffic (no downtime)
  → If it crashes repeatedly, K8s uses "backoff" — waits longer between restarts
    (10s, 20s, 40s, 80s, ... up to 5 minutes)
  → This is called CrashLoopBackOff in pod status
```

**You lose nothing.** K8s handles this automatically. The other pods keep running.

### Pod uses too much memory (OOMKill)

```
Pod memory exceeds 3Gi limit
  → Linux kernel kills the process (OOMKilled)
  → K8s sees the container exited with code 137
  → K8s restarts the pod on the same node
  → If it keeps OOMing, it goes into CrashLoopBackOff
```

If you see this happening a lot, you need to either fix the memory leak or increase the memory limit.

### Node dies (hardware failure, AWS issue, etc.)

```
Node goes down
  → K8s notices within ~40 seconds (node heartbeat stops)
  → K8s marks all pods on that node as "Unknown"
  → After ~5 minutes, K8s evicts those pods
  → K8s schedules replacement pods on the remaining healthy nodes
  → If remaining nodes don't have enough room, Cluster Autoscaler adds a new node
  → Your PDB guarantees at least 50% of pods were on OTHER nodes already
```

**Because we spread pods across nodes** (`topologySpreadConstraints`), losing one node typically means losing only 1-2 pods out of 4+. The other pods keep serving traffic.

### App returns errors but process is running (deadlock, stuck, etc.)

```
App stops responding to /v1/health-docker
  → Readiness probe fails (3 times × 10s = 30 seconds)
  → K8s removes pod from load balancer (no new traffic)
  → Liveness probe fails (3 times × 30s = 90 seconds)
  → K8s kills and restarts the pod
  → Pod comes back up, passes probes, rejoins load balancer
```

Total time from "app stuck" to "pod restarted" is roughly **2 minutes**.

### Deployment goes bad (new image is broken)

```
New image deployed via rolling update
  → K8s starts 1 new pod with new image
  → New pod fails startup probe (crashes, health check fails, etc.)
  → K8s does NOT remove any old pods (maxUnavailable: 0)
  → Rollout is stuck — old pods keep serving traffic
  → After 5 minutes, the CI/CD timeout reports failure
```

The old pods keep running. Your users don't notice anything. To fix it:
```bash
# See what's wrong
kubectl describe pod -n suna -l app.kubernetes.io/name=suna-api

# Roll back to the previous version
kubectl rollout undo deployment/suna-api -n suna

# Verify
kubectl rollout status deployment/suna-api -n suna
```

### All pods on all nodes go down (catastrophic failure)

This is extremely unlikely (would require all nodes in multiple availability zones to fail simultaneously), but if it happens:

```
All pods down
  → ALB health checks fail
  → ALB returns 503 to all requests
  → CloudWatch alarm fires (pod count < 1)
  → Email alert sent via SNS
  → Cluster Autoscaler adds new nodes
  → K8s reschedules pods on new nodes
  → ALB health checks pass, traffic resumes
```

Manual recovery if needed:
```bash
# Check cluster status
kubectl get nodes
kubectl get pods -n suna

# Force restart all pods
kubectl rollout restart deployment/suna-api -n suna

# If nodes are gone, check AWS console for the managed node group
# Or scale it manually:
aws eks update-nodegroup-config \
  --cluster-name suna-eks \
  --nodegroup-name suna-api-nodes \
  --scaling-config minSize=2,maxSize=8,desiredSize=3
```

---

## Monitoring

We have three monitoring layers:

### 1. CloudWatch (AWS native)

**Dashboard:** Go to AWS Console → CloudWatch → Dashboards → `suna-api-prod`

Shows:
- Node CPU utilization
- Node memory utilization
- Running pod count
- Node count
- Pod-level CPU and memory
- Network I/O

**Alarms** (sends email alerts):

| Alarm | Threshold | Severity |
|-------|-----------|----------|
| CPU Warning | > 70% for 10 minutes | Warning |
| CPU Critical | > 85% for 2 minutes | Critical |
| Memory Warning | > 75% for 10 minutes | Warning |
| Memory Critical | > 90% for 2 minutes | Critical |
| Pod Count Low | < 1 running pod for 2 minutes | Critical |
| Node Count Low | < 2 nodes for 2 minutes | Critical |

### 2. Better Stack (cloud observability)

Better Stack collects logs and metrics from all containers in the cluster using an eBPF-based collector (DaemonSet — runs on every node).

- **Logs:** Telemetry → Logs (or Live tail)
- **Dashboards:** Telemetry → Dashboards
- **Uptime:** Set up HTTP monitors for `api-eks.kortix.com`

### 3. Terminal monitoring

For quick checks from your laptop:

```bash
# See everything at a glance
bash infra/scripts/k8s-monitor.sh

# Or individual commands:
kubectl top nodes                          # Node CPU/memory
kubectl top pods -n suna                   # Pod CPU/memory
kubectl get pods -n suna                   # Pod status
kubectl get hpa -n suna                    # Autoscaler status
kubectl get events -n suna --sort-by='.lastTimestamp'  # Recent events
```

---

## Common Operations

### Check what's running

```bash
# What image is each pod running?
kubectl get pods -n suna -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'

# Is the latest deploy live?
kubectl get deployment suna-api -n suna -o jsonpath='{.spec.template.spec.containers[0].image}'

# How many pods are running?
kubectl get deployment suna-api -n suna

# What's the HPA doing?
kubectl get hpa -n suna
```

### Restart pods (without redeploying)

```bash
# Graceful rolling restart (zero downtime)
kubectl rollout restart deployment/suna-api -n suna

# Watch the restart progress
kubectl rollout status deployment/suna-api -n suna
```

### View logs

```bash
# Logs from a specific pod
kubectl logs <pod-name> -n suna

# Logs from all suna-api pods
kubectl logs -l app.kubernetes.io/name=suna-api -n suna --tail=100

# Follow logs in real-time
kubectl logs -l app.kubernetes.io/name=suna-api -n suna -f

# Logs from a crashed pod (previous container)
kubectl logs <pod-name> -n suna --previous
```

### Scale manually

```bash
# Scale pods (temporarily — HPA may override this)
kubectl scale deployment/suna-api -n suna --replicas=6

# To permanently change, update the HPA min:
kubectl patch hpa suna-api -n suna -p '{"spec":{"minReplicas":6}}'

# Scale nodes (via AWS)
aws eks update-nodegroup-config \
  --cluster-name suna-eks \
  --nodegroup-name suna-api-nodes \
  --scaling-config minSize=3,maxSize=8,desiredSize=4
```

### Roll back a deployment

```bash
# See deployment history
kubectl rollout history deployment/suna-api -n suna

# Roll back to previous version
kubectl rollout undo deployment/suna-api -n suna

# Roll back to a specific revision
kubectl rollout undo deployment/suna-api -n suna --to-revision=3
```

### Debug a pod

```bash
# See why a pod isn't starting
kubectl describe pod <pod-name> -n suna

# Get a shell inside a running pod
kubectl exec -it <pod-name> -n suna -- /bin/bash

# See resource usage
kubectl top pod <pod-name> -n suna
```

### Check node health

```bash
# Node overview
kubectl get nodes -o wide

# Detailed node info (capacity, conditions, pods running on it)
kubectl describe node <node-name>

# What's running on each node
kubectl get pods -n suna -o wide
```

---

## Secrets Management

Environment variables (API keys, database URLs, etc.) flow like this:

```
AWS Secrets Manager (suna-env-prod)
  → CI/CD syncs to K8s secret (on every deploy)
  → K8s secret: suna-env in namespace suna
  → Mounted as env vars in every pod
```

### Update a secret

**Option A: Through a deploy** (automatic)

Every time CI/CD deploys to EKS, it syncs secrets from Secrets Manager. So:
1. Update the value in AWS Secrets Manager (`suna-env-prod`)
2. Push to PRODUCTION branch (or trigger a deploy)
3. The deploy job syncs the secret and deploys the new image

**Option B: Manual sync** (no code change needed)

Go to GitHub Actions → "Sync Secrets to EKS" → Run workflow:
1. Type `sync` in the confirm field
2. Choose whether to restart the deployment
3. Click "Run workflow"

Or from the command line:
```bash
# Fetch from Secrets Manager and apply to K8s
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id suna-env-prod \
  --query SecretString --output text)

kubectl create secret generic suna-env -n suna \
  --from-env-file=<(echo "$SECRET_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for k, v in data.items():
    print(f'{k}={v}')
") --dry-run=client -o yaml | kubectl apply -f -

# Restart pods to pick up new secrets
kubectl rollout restart deployment/suna-api -n suna
```

Pods need to be restarted to pick up secret changes — K8s doesn't hot-reload env vars.

---

## Troubleshooting

### "Pods are stuck in Pending"

The nodes are full. Either:
```bash
# Check what's waiting
kubectl get pods -n suna --field-selector=status.phase=Pending
kubectl describe pod <pending-pod> -n suna  # Look at "Events" section

# Check node capacity
kubectl top nodes

# The Cluster Autoscaler should handle this automatically.
# Check its logs if nodes aren't being added:
kubectl logs -l app.kubernetes.io/name=cluster-autoscaler -n kube-system --tail=50
```

### "Pods are in CrashLoopBackOff"

The app is crashing on startup repeatedly.
```bash
# See why
kubectl logs <pod-name> -n suna --previous
kubectl describe pod <pod-name> -n suna

# Common causes:
# - Missing env vars (secret not synced)
# - Database connection failed
# - OOMKilled (check memory limits)
# - Bad image (roll back)
```

### "High memory but Cluster Autoscaler isn't adding nodes"

Cluster Autoscaler only adds nodes when pods are **Pending** (can't be scheduled). If pods are running but using lots of memory, that's fine from K8s's perspective — the pods are scheduled and running.

If you want to add headroom:
```bash
# Increase the number of nodes
aws eks update-nodegroup-config \
  --cluster-name suna-eks \
  --nodegroup-name suna-api-nodes \
  --scaling-config minSize=3,maxSize=8,desiredSize=4
```

### "Deploy succeeded but the app is broken"

```bash
# Roll back immediately
kubectl rollout undo deployment/suna-api -n suna

# Check what went wrong
kubectl logs -l app.kubernetes.io/name=suna-api -n suna --tail=200
kubectl get events -n suna --sort-by='.lastTimestamp'
```

### "I need to SSH into a node"

You generally shouldn't need to, but if you do:
```bash
# Find the EC2 instance ID
kubectl get nodes -o wide  # Note the INTERNAL-IP

# Use SSM Session Manager (no SSH key needed)
aws ssm start-session --target <instance-id>
```

### "How do I know if it's my code or K8s?"

Quick checklist:
1. `kubectl get pods -n suna` — Are pods Running? If not, it's a K8s/infra issue.
2. `kubectl top pods -n suna` — Is CPU/memory maxed? If yes, scale up or fix the leak.
3. `kubectl logs <pod> -n suna` — Are there errors? If yes, it's your code.
4. `kubectl get events -n suna` — Any K8s-level events? (OOMKilled, FailedScheduling, etc.)
5. Check Better Stack logs for patterns.

---

## Quick Reference Card

| I want to... | Command |
|---|---|
| See all pods | `kubectl get pods -n suna` |
| See pod logs | `kubectl logs <pod> -n suna` |
| See resource usage | `kubectl top pods -n suna` |
| Restart all pods | `kubectl rollout restart deployment/suna-api -n suna` |
| Roll back | `kubectl rollout undo deployment/suna-api -n suna` |
| Scale pods | `kubectl scale deployment/suna-api -n suna --replicas=6` |
| Check HPA | `kubectl get hpa -n suna` |
| Check nodes | `kubectl get nodes -o wide` |
| See events | `kubectl get events -n suna --sort-by='.lastTimestamp'` |
| Shell into pod | `kubectl exec -it <pod> -n suna -- /bin/bash` |
| Check current image | `kubectl get deploy suna-api -n suna -o jsonpath='{.spec.template.spec.containers[0].image}'` |
| Full monitoring dashboard | `bash infra/scripts/k8s-monitor.sh` |
