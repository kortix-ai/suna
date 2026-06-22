# Runbook: Deployment Procedure

How a code change reaches **dev** (`kortix-dev-eks`, us-west-2) and **prod**
(`kortix-prod-eks`, eu-west-2). Both clusters deploy by **GitOps**: a commit
bumps `image.tag` in `infra/k8s/envs/<env>/values.yaml`, and Argo CD reconciles
the change onto the cluster. There is no `kubectl apply` / `helm upgrade` in the
hot path — the git commit *is* the deploy.

- **`main`** = DEV. Every push auto-deploys to dev.
- **`prod`** = PROD. Advanced only by the **Promote** workflow + a reviewed PR.
- **`VERSION`** (repo root) = one number for the whole platform.
- **Retag, never rebuild** — prod ships the exact image bytes tested on dev.

Ground truth: `infra/GITOPS.md`, `infra/CICD.md`, `infra/EKS.md`,
`infra/k8s/argocd/applications/{dev,prod}.yaml`.

---

## 1. Deploy to DEV (merge to `main`)

```
PR ─► ci.yml · codeql.yml · secret-scan.yml
 │ merge to main
 ▼
deploy-dev.yml  (push → main)
  build+push kortix/kortix-api:dev-<sha8>
  └─ deploy-api job: yq -i '.image.tag = "dev-<sha8>"' infra/k8s/envs/dev/values.yaml
       git commit -m "chore(dev-eks): deploy dev-<sha8> [skip ci]"  → push to main
         └─► Argo CD app `kortix-dev` (tracks main) syncs → rolling Deployment on kortix-dev-eks
```

Steps:

1. Open a PR into `main`. `ci.yml`, `codeql.yml`, `secret-scan.yml` run.
2. Merge. The `deploy-dev.yml` workflow (`.github/workflows/deploy-dev.yml`)
   triggers on the push to `main`. Only surfaces whose paths changed rebuild
   (path-filtered: `apps/api`, `packages`, `packages/db/migrations`, lockfiles,
   `VERSION`, etc.). If the API surface changed, the `migrate-db` job applies
   pending node-pg-migrate migrations against dev before the GitOps rollout.
3. The `deploy-api` job (name: **Deploy API to dev (EKS / GitOps)**) builds and
   pushes `kortix/kortix-api:dev-<sha8>`, then bumps
   `infra/k8s/envs/dev/values.yaml` `image.tag` to that immutable tag and commits
   it back to `main` (`[skip ci]`). It assumes the OIDC role
   `arn:aws:iam::935064898258:role/kortix-gha-eks-deploy-dev`.
4. Argo CD's `kortix-dev` Application (`infra/k8s/argocd/applications/dev.yaml`,
   `targetRevision: main`, `automated: { prune: true, selfHeal: true }`)
   reconciles the bump and rolls the Deployment.
5. The workflow then `aws eks update-kubeconfig --name kortix-dev-eks --region
   us-west-2` and **watches** the rollout converge on `dev-<sha8>` (compares
   `observedGeneration`, `updatedReplicas`, `availableReplicas`) for ~15 min.

### Verify dev

```bash
aws eks update-kubeconfig --name kortix-dev-eks --region us-west-2
kubectl -n kortix-dev get deploy kortix-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # → kortix/kortix-api:dev-<sha8>
kubectl -n kortix-dev rollout status deploy/kortix-api
argocd app get kortix-dev                                          # Synced / Healthy
curl -fsS https://dev-api-eks.kortix.com/v1/health | jq .version
```

---

## 2. Deploy to PROD (Promote → review → merge to `prod`)

Prod moves **only** when someone runs **Promote** and the resulting PR is
reviewed and merged into `prod`. Nothing on `main` can touch prod — the
`kortix-prod` Argo Application tracks `targetRevision: prod`.

```
Actions → "Promote to Production" (promote.yml, workflow_dispatch)
  computes next vX.Y.Z from VERSION on prod
  opens reviewed PR  release/vX.Y.Z → prod  (stamps VERSION + RELEASE_NOTES.md
    AND bumps infra/k8s/envs/prod/values.yaml image.tag + kortixVersion)
        │ review + merge to prod
        ▼
deploy-prod.yml  (push → prod)
  retag dev image  kortix/kortix-api:dev-<sha8> → :X.Y.Z + :latest   (NO rebuild)
  build prod CLI → cut GitHub Release vX.Y.Z
  deploy-api job: WATCHES Argo CD roll kortix-prod-eks to :X.Y.Z, then Slack
        └─► Argo CD app `kortix-prod` (tracks prod) syncs → rolling Deployment
```

Steps:

1. **Actions → "Promote to Production"** (`.github/workflows/promote.yml`) → Run
   workflow. Provide a release title + notes, pick a `bump`
   (patch/minor/major), or set an explicit `version`.
2. The workflow computes the next `vX.Y.Z` from `VERSION` on `prod`, freezes a
   `release/vX.Y.Z` branch (`merge -s ours origin/prod` so prod is always an
   ancestor → clean merge), and **opens a PR into the protected `prod` branch**.
   It does **not** tag, release, or deploy — that all happens after the merge.
3. **Review the release PR.** Confirm `VERSION`, the changelog notes, and the
   `infra/k8s/envs/prod/values.yaml` `image.tag` + `kortixVersion` bump. The
   `prod` branch is protection-gated; the promote PR carries the values bump.
4. **Merge to `prod`.** The push triggers `deploy-prod.yml`
   (`.github/workflows/deploy-prod.yml`, name **Deploy Prod**):
   - `retag-images`: retags the tested dev image `dev-<sha8>` → `:X.Y.Z` +
     `:latest` (no rebuild — what was tested on dev is what ships).
   - `version` / CLI / desktop jobs: cut the GitHub Release `vX.Y.Z` (desktop is
     best-effort, never blocks).
   - `migrate-db` job: applies pending `packages/db/migrations` with
     node-pg-migrate (`pnpm --filter @kortix/db migrate`) against prod before any
     new API pods serve.
   - `deploy-api` job (name: **Deploy API to prod (EKS / GitOps)**): assumes
     `arn:aws:iam::935064898258:role/kortix-gha-eks-deploy`, runs `aws eks
     update-kubeconfig --name kortix-prod-eks --region eu-west-2`, and **watches**
     Argo CD's `kortix-prod` app roll the Deployment to exactly `:X.Y.Z`.
     `kortixVersion` came from the values bump, so `/v1/health` reports the clean
     `X.Y.Z`.

### The `production` approval gate

The intended human approval gate is the GitHub **`production` Environment**
(Settings → Environments → `production`, with required reviewers). When set, the
`deploy-api` job in `deploy-prod.yml` pauses for sign-off before it touches prod.

> **Status — to be wired.** As of now `deploy-prod.yml`'s `deploy-api` job does
> not yet declare `environment: production` (no `environment:` key present), so
> the gate is **not enforced in the workflow**. The current human gate is the
> reviewed promote PR into the protected `prod` branch. To enforce the runtime
> gate, create the `production` Environment with required reviewers and add
> `environment: production` to the `deploy-api` job. See `infra/GITOPS.md`
> ("Approval gate") — note the Actions bot must be allowed to push the bump
> commit to `prod` under branch protection.

### Verify prod

```bash
aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2
kubectl -n kortix-prod get deploy kortix-api \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # → kortix/kortix-api:X.Y.Z
kubectl -n kortix-prod rollout status deploy/kortix-api
kubectl -n kortix-prod get pods -o wide                           # spread across 3 AZs
argocd app get kortix-prod                                        # Synced / Healthy
curl -fsS https://api-eks.kortix.com/v1/health | jq .version       # → "X.Y.Z"
```

---

## Notes & gotchas

- **Migrations**: live dev/prod deploys use the GitHub Actions `migrate-db` jobs
  and node-pg-migrate (`packages/db/MIGRATIONS.md`), before the EKS GitOps roll.
  The chart-level PreSync hook is disabled and still reflects the old Drizzle
  path; do **not** enable `migrate.enabled` until the hook is ported or removed
  (https://github.com/kortix-ai/suna/issues/3628).
- **Preview envs**: per-PR ephemeral APIs deploy via the Argo CD ApplicationSet
  (`infra/k8s/argocd/applicationsets/preview.yaml`) into `kortix-pr-<n>`
  namespaces on dev-eks when a PR is labelled `preview`. See `docs/ONBOARDING.md`.
- **Canary is off** (`rollout.enabled: false` in all envs). Delivery today is a
  plain rolling Deployment (auto-healing probes + HPA + zero-downtime rolling
  update). See `docs/runbooks/rollback-procedure.md` for the canary auto-abort
  path when it is re-enabled.
- **`SANDBOX_VERSION` ≠ `KORTIX_VERSION`** — never repurpose `SANDBOX_VERSION`
  for the app version (it content-hashes sandbox snapshots).
