# Runbook: Rollback Procedure

Because deploys are GitOps, **rollback is also git**. The desired state lives in
`infra/k8s/envs/<env>/values.yaml`; Argo CD reconciles the cluster to whatever
that file says at the tracked revision. There are three paths, in order of
preference.

| Cluster | Namespace | Argo app | Tracks branch | Region |
|---|---|---|---|---|
| `kortix-prod-eks` | `kortix-prod` | `kortix-prod` | `prod` | eu-west-2 |
| `kortix-dev-eks` | `kortix-dev` | `kortix-dev` | `main` | us-west-2 |

```bash
# Set context for the affected env first.
aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2   # prod
# aws eks update-kubeconfig --name kortix-dev-eks --region us-west-2  # dev
```

---

## Path 1 (PRIMARY): `git revert` the values bump

The deploy was a commit that bumped `image.tag`. Reverting that commit restores
the previous tag; Argo CD (`automated: { selfHeal: true, prune: true }`) rolls
back automatically. This keeps git as the single source of truth — no manual
cluster surgery, no drift.

**Prod** (revert on the `prod` branch):

```bash
git fetch origin prod
git switch -c rollback/prod-revert origin/prod
# Find the offending deploy commit (the image.tag bump).
git log --oneline -- infra/k8s/envs/prod/values.yaml | head
git revert --no-edit <bad_commit_sha>
git push -u origin rollback/prod-revert
# Open a PR into `prod`, review, merge. Argo CD reconciles to the prior tag.
```

> Prod is protection-gated, so the revert lands via a PR into `prod` (same gate
> as a forward deploy). In a SEV1 where the protected-branch PR is too slow, use
> Path 2 (`argocd app rollback`) for the immediate stop-the-bleed, then land the
> `git revert` so git matches the cluster again (otherwise self-heal fights you).

**Dev** (revert on `main`):

```bash
git switch main && git pull
git log --oneline -- infra/k8s/envs/dev/values.yaml | head
git revert --no-edit <bad_commit_sha>
git push origin main
```

---

## Path 2: `argocd app rollback` (fast, in-cluster)

Use when you need an immediate revert and don't want to wait on the git/PR loop
(SEV1). This rolls the Argo Application to a previous **synced revision** from
its history.

```bash
# Connect (port-forward, or `argocd login ops.kortix.com --grpc-web`).
kubectl -n argocd port-forward svc/argo-cd-argocd-server 8080:443 &
argocd login localhost:8080 --insecure \
  --username admin \
  --password "$(kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d)"

argocd app history kortix-prod                 # list revisions (ID + git SHA + deployed-at)
argocd app rollback kortix-prod <HISTORY_ID>   # roll to a known-good revision
argocd app get kortix-prod                      # watch → Synced / Healthy
```

> **Important — self-heal will fight you.** `kortix-prod` has
> `selfHeal: true`, so the cluster is continuously reconciled to the *git*
> revision. `argocd app rollback` is a stop-gap; you **must** follow it with the
> Path 1 `git revert` so git and cluster agree. If you don't, Argo re-syncs
> forward to the bad tag on the next reconcile. (To freeze during an incident:
> `argocd app set kortix-prod --sync-policy none`, fix git, then re-enable
> `--sync-policy automated --self-heal`.)

---

## Path 3: Canary auto-abort (when `rollout.enabled: true`)

Today all envs run a **plain rolling Deployment** (`rollout.enabled: false` in
`infra/k8s/envs/*/values.yaml`), so this path is dormant. It activates when the
Argo Rollouts canary is re-enabled (planned at the `api.kortix.com` cutover —
see `infra/GITOPS.md` "Canary" and `infra/INFRASTRUCTURE_PLAN.md` Wave 5).

When enabled, a bad release rolls back on its own:

- **Pod-health abort** (always, even with `analysis.enabled: false`): a bad
  image whose pods never go Ready holds/aborts the canary at the first step —
  the bad version never receives traffic.
- **Metric-analysis abort** (`rollout.analysis.enabled: true`): a background
  AnalysisRun queries CloudWatch (ALB 5xx-rate + p95 latency over the target
  group, via the Rollouts controller IRSA role) every minute and **auto-aborts
  to the stable ReplicaSet** on two consecutive breaches. Dimensions are pinned
  in `infra/k8s/envs/prod/values.yaml` (`rollout.analysis.lbArnSuffix` /
  `tgArnSuffix`).

Drive / inspect a canary:

```bash
kubectl argo rollouts get rollout kortix-api -n kortix-prod --watch
kubectl argo rollouts abort    kortix-api -n kortix-prod    # manual abort → back to stable
kubectl argo rollouts undo     kortix-api -n kortix-prod    # roll to previous stable
```

After an auto-abort, still land the `git revert` (Path 1) so git no longer
points at the bad tag.

---

## Verify the rollback succeeded

```bash
# 1) The Deployment is running the GOOD tag.
kubectl -n kortix-prod get deploy kortix-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'

# 2) Rollout converged; all replicas available.
kubectl -n kortix-prod rollout status deploy/kortix-api
kubectl -n kortix-prod get pods -o wide

# 3) Argo is Synced/Healthy and on the reverted git SHA.
argocd app get kortix-prod

# 4) The app serves the expected version and is healthy.
curl -fsS https://api-eks.kortix.com/v1/health | jq '{version, status}'

# 5) Error rate / latency back to baseline in Grafana (golden-signals dashboard).
```

A rollback is **done** when: the Deployment image is the prior good tag, the
rollout shows all replicas available, `argocd app get` is `Synced/Healthy` on
the reverted SHA, `/v1/health` returns the expected version, and the
golden-signals dashboard shows 5xx/latency back to baseline. Record the bad SHA,
the trigger, and the recovery time for the post-incident review
(`docs/runbooks/incident-response.md`).
