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

Quick (no setup):

```bash
kubectl -n argocd port-forward svc/argo-cd-argocd-server 8080:443   # https://localhost:8080
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d  # admin pw
argocd app get kortix-prod        # Synced / Healthy
argocd app history kortix-prod    # releases; `argocd app rollback` or git revert
```

### Company domain — `ops.kortix.com` (gated)

Argo CD is an admin control plane, so the public URL is **Cloudflare-Access
gated** and the ALB is **locked to Cloudflare IPs** (so the gate can't be
bypassed via the raw ALB DNS). Bring it up in this order so it's never reachable
unauthenticated:

1. **Apply the cert** — `environments/prod-eks/cluster` (adds the `ops.kortix.com`
   ACM cert; validates via Cloudflare DNS).
2. **Apply the ingress** — set `argocd_ui_enabled = true` in the `platform`
   tfvars and apply. The ALB comes up; `ops.kortix.com` does NOT resolve yet.
3. **Cloudflare Access** (Zero Trust dashboard → Access → Applications → Add):
   - Type **Self-hosted**, Application domain `ops.kortix.com`.
   - Policy: **Allow**, Include → *Emails ending in* `@kortix.com` (or a group).
   - (Optional) shorter session duration for an admin app.
4. **Add the DNS record** — proxied CNAME `ops.kortix.com` → the Argo CD ALB
   hostname (`kubectl -n argocd get ingress`). Now it resolves AND is gated.
5. (Recommended) wire **Argo CD GitHub-org SSO** so logins map to people, then
   disable the shared `admin` account.

CLI through the gateway uses gRPC-Web: `argocd login ops.kortix.com --grpc-web`.

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

## Branch = environment (why constant merges to main are safe)

```
PRs merge to main  ─►  DEV only        (dev Argo app tracks `main`)
                       prod untouched

Actions → Promote   ─►  merges main → `prod` branch (reviewed)
   └─ deploy-prod-eks bumps image.tag in prod's envs/prod/values.yaml
        (GitHub Environment `production` approval)
                       └─►  prod Argo app (tracks `prod`) syncs ─► PROD
```

The **prod Application tracks the `prod` branch** — so nothing on `main` can
touch prod. Prod moves *only* when someone runs **Promote** (merges to `prod`)
and the image bump lands on `prod`. (Bootstrap note: the app currently tracks
`main` until the first promote puts the GitOps manifests on `prod`; then repoint
`spec.sources[].targetRevision` from `main` → `prod` — a one-line change.)

## GitHub-org SSO + retiring admin

1. **Create a GitHub OAuth App** (org `kortix-ai` → Settings → Developer settings
   → OAuth Apps → New):
   - Homepage `https://ops.kortix.com`
   - Authorization callback `https://ops.kortix.com/api/dex/callback`
   - copy the **Client ID**, generate a **Client Secret**.
2. In the `platform` tfvars / env:
   ```
   argocd_github_sso_enabled = true
   argocd_github_client_id   = "<client id>"
   argocd_admin_team         = "<github team that gets admin>"   # e.g. eng
   export TF_VAR_argocd_github_client_secret=<client secret>
   ```
   `terraform apply`. Org members can now **Log in via GitHub**; the admin team
   gets admin, everyone else read-only.
3. **Verify** GitHub login + that your admin team has admin in the UI.
4. **Only then** retire the shared password: set `argocd_disable_admin = true`
   and `terraform apply`. (Doing this before step 3 locks you out.)

## Environment profiles

`envs/<env>/values.yaml` sets `env.internalKortixEnv` and `workers.enabled`.
`workers.enabled: false` forces the leader-elected singleton jobs off (scheduler,
project maintenance, legacy + suna migration) so a pre-prod/canary that shares
prod data never runs background work even if it wins the Postgres leader lease.
At the api.kortix.com cutover, flip prod `workers.enabled: true` here AND disable
the ECS service in the same change.
