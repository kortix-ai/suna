# GitOps release pipeline (Argo CD + Argo Rollouts)

The deploy engine for EKS. Argo CD continuously reconciles the cluster to the
manifests in `infra/k8s/`; Argo Rollouts (Phase 2) drives metric-analyzed
canaries. This replaces the imperative `helm upgrade` / `aws ecs` deploys.

```
infra/k8s/
  charts/kortix-api/        # the app chart (Deployment now; Rollout in Phase 2)
  envs/<env>/values.yaml     # per-env values — image.tag here IS the release
  argocd/
    project.yaml             # AppProject "kortix" (scoping)
    app-of-apps.yaml         # parent app → syncs applications/
    applications/<env>.yaml  # one Argo Application per env
```

## How a deploy works

- **Deploy** = a commit/PR that bumps `image.tag` in `infra/k8s/envs/<env>/values.yaml`. Argo CD syncs it onto the cluster.
- **Rollback** = `git revert` that commit. Argo CD reconciles back.
- **Drift** (anyone `kubectl edit`s a managed resource) is auto-reverted (`selfHeal: true`).
- The Application tracks a branch per env: **prod → `prod`**, dev → `main` (Phase 3).

## Bootstrap (one time)

Argo CD + Rollouts are installed by the platform Terraform
(`modules/eks/platform` → `helm_release.argo_cd` / `argo_rollouts`). Then:

1. **Connect the repo** (Argo CD needs read access to the private repo). A
   read-only **deploy key** is added to the repo and its private key registered
   as an Argo CD repo credential.
2. **Apply** `project.yaml` + `app-of-apps.yaml`. The app-of-apps syncs
   `applications/`, which creates the `kortix-prod` Application.
3. `kortix-prod` **adopts** the already-running kortix-api resources and
   reconciles them to `envs/prod/values.yaml` (pins the release tag, API-only
   profile pre-cutover).

**Bootstrap source override:** until these manifests are merged to
`kortix-ai/suna`, the apps are created against the branch where they live (e.g.
`--repo https://github.com/lillyboga/suna.git --revision eks-migration`). Once
merged, drop the override so the committed `kortix-ai/suna` / `prod` source
takes over.

## Access Argo CD

```bash
kubectl -n argocd port-forward svc/argocd-server 8080:443   # then https://localhost:8080
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d  # admin pw
argocd app get kortix-prod        # Synced / Healthy
argocd app history kortix-prod    # releases; `argocd app rollback` or git revert
```

## Release flow & the GitHub Actions

Promotion keeps its good bones (one `VERSION`, retag-don't-rebuild, review-gated
promote). What changes is how the deploy *happens*:

| Workflow | Role now (dual-run) | At api.kortix.com cutover |
| --- | --- | --- |
| `deploy-prod-eks.yml` | After the image is retagged, **bumps `envs/prod/values.yaml` → Argo CD deploys EKS** (gated by GitHub Environment `production`). No kubectl/helm. | becomes the **sole** prod deploy |
| `deploy-prod.yml` | unchanged — retag · CLI · desktop · GitHub Release · **rolls ECS** (ECS still serves api.kortix.com) | **drop the `deploy-api` (ECS roll) job** |
| `deploy-dev.yml` | unchanged — builds + rolls ECS dev | Phase 3: drop ECS roll, bump `envs/dev/values.yaml` |
| `e2e.yml` | unchanged (WIP, non-gating) | wire as a required gate when ready |

A release = merge the promote PR → `deploy-prod` retags + cuts the release →
`deploy-prod-eks` bumps the prod values → Argo CD rolls EKS. **Rollback = `git
revert`** the values bump (or `argocd app rollback`).

**Approval gate:** create the `production` GitHub Environment (Settings →
Environments) with required reviewers — the `deploy-prod-eks` job then pauses for
sign-off before it touches prod. Branch protection note: the job pushes the bump
commit to `prod`; allow the Actions bot to push (or relax the rule for it), the
same way `deploy-prod`'s `sync-main-version` pushes to `main`.

## Canary (Phase 2)

`rollout.enabled: true` in an env's values turns the Deployment into an Argo
Rollouts **canary** (10→25→50→100% via `rollout.steps`). With
`rollout.analysis.enabled: true`, a background AnalysisRun queries **CloudWatch**
(ALB 5xx-rate + p95 latency over the target group) every minute and **aborts the
rollout (auto-rollback to stable)** on two consecutive breaches. The Rollouts
controller reads CloudWatch via its IRSA role (`modules/eks/platform`).

The analysis needs the ALB's CloudWatch dimensions — set them once from the live
ALB (stable for the life of the ingress) in `envs/prod/values.yaml`:

```bash
ALB=$(kubectl -n kortix-prod get ingress kortix-api -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
# rollout.analysis.lbArnSuffix = app/<alb-name>/<id>   (from the ALB ARN)
# rollout.analysis.tgArnSuffix = targetgroup/<tg-name>/<id>   (from the target group ARN)
```

Watch a canary: `kubectl argo rollouts get rollout kortix-api -n kortix-prod --watch`.

## Environment profiles

`envs/<env>/values.yaml` sets `env.internalKortixEnv` and `workers.enabled`.
`workers.enabled: false` forces the leader-elected singleton jobs off (scheduler,
project maintenance, legacy + suna migration) so a pre-prod/canary that shares
prod data never runs background work even if it wins the Postgres leader lease.
At the api.kortix.com cutover, flip prod `workers.enabled: true` here AND disable
the ECS service in the same change.
