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

## Environment profiles

`envs/<env>/values.yaml` sets `env.internalKortixEnv` and `workers.enabled`.
`workers.enabled: false` forces the leader-elected singleton jobs off (scheduler,
project maintenance, legacy + suna migration) so a pre-prod/canary that shares
prod data never runs background work even if it wins the Postgres leader lease.
At the api.kortix.com cutover, flip prod `workers.enabled: true` here AND disable
the ECS service in the same change.
