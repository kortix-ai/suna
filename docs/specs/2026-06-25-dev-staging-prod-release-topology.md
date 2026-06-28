# Dev / Staging / Prod Release Topology

Date: 2026-06-25

## Goal

Kortix should have three clear environments:

| Environment | Git branch | Frontend | API router | Primary API backend | Fallback API backend | Purpose |
| --- | --- | --- | --- | --- | --- | --- |
| dev | `main` | `dev.kortix.com` | `dev-api.kortix.com` | `dev-api-eks.kortix.com` | `dev-api-ecs-fargate.kortix.com` | fast development trunk, direct pushes allowed |
| staging | `staging` | `staging.kortix.com` | `staging-api.kortix.com` | `staging-api-eks.kortix.com` | future `staging-api-ecs-fargate.kortix.com` | pre-prod, e2e, release candidate validation |
| prod | `prod` | `kortix.com` | `api.kortix.com` | `api-eks.kortix.com` | `api-ecs-fargate.kortix.com` | production |

The branch flow is:

```text
main/dev
  ├─ PR main directly into staging
  │     or
  └─ targeted branch PR directly into staging
        ↓
staging/pre-prod
        ↓ Promote to Production action opens reviewed release PR
prod/production
```

## Branch Rules

### `main`

`main` is the repo default branch and dev trunk. It should be push-friendly:

- direct pushes allowed;
- force-pushes disabled;
- branch deletion disabled;
- PRs still allowed, but not mandatory;
- push to `main` deploys dev.

This gives the team a free development lane where CI still reports failures but does not turn every small dev change into a protected-branch ceremony.

### `staging`

`staging` is the pre-prod source of truth. Treat anything on staging as
production-ready unless QA proves otherwise. Human/code changes move in two ways:

1. **PR main to Staging**: stage the full dev candidate.
2. **PR targeted branch to Staging**: stage a release candidate, rollback candidate, or one-off selective patch without taking all of `main`.

The staging deploy workflow may add `[skip ci]` GitOps pin commits after a PR
merge so Argo CD can roll exact image tags. Those bot commits are deployment
metadata, not a human promotion path.

Every push to `staging` must build exact staging artifacts:

- `kortix/kortix-api:staging-<sha8>`
- `kortix/kortix-gateway:staging-<sha8>`
- `kortix/kortix-frontend:staging-<sha8>`
- mutable `staging-latest` tags for inspection only

Production promotion must prefer those exact `staging-<sha8>` artifacts. That prevents a staging-only commit from accidentally shipping whatever `dev-latest` currently points at.

### `prod`

`prod` remains protected. Production moves only when `promote.yml` opens a release PR from `staging` into `prod` and that PR is merged.

The release PR stamps:

- `VERSION`
- `RELEASE_NOTES.md`
- `RELEASE_SOURCE_SHA`
- prod GitOps image tags

`deploy-prod.yml` runs only after the merge to `prod`.

## Runtime Shape

All three API environments should use the same runtime shape:

```text
<env>-api.kortix.com
  ↓ Cloudflare Worker router
ACTIVE_BACKEND = eks | ecs-fargate
  ├─ EKS primary: <env>-api-eks.kortix.com
  └─ ECS fallback: <env>-api-ecs-fargate.kortix.com
```

This keeps failover identical everywhere:

- flip `ACTIVE_BACKEND` to `ecs-fargate` for an instant fallback;
- flip it back to `eks` after EKS is healthy;
- no DNS cutover is required for backend failover;
- both backends run against the same environment-specific data plane and secret bundle.

## Staging Infrastructure Target

Staging should be isolated from both dev and prod:

- AWS runtime region target: `eu-west-2`
- Current first implementation: `kortix-dev-eks` / `us-west-2` with isolated
  namespace, IAM role, hosts, and secret bundle until a dedicated staging EKS is
  provisioned
- Supabase/Postgres data plane: `Kortix STAGING` project
  `ujzsbwvurfyeuerxxeaz` in `eu-west-2`; staging must not use the dev or prod
  Supabase/Postgres projects
- ECS VPC CIDR: `10.50.0.0/16`
- EKS VPC CIDR: `10.60.0.0/16`
- EKS cluster: `kortix-staging-eks`
- Kubernetes namespace: `kortix-staging`
- Secrets Manager bundle: `kortix-staging-env`
- EKS deploy role: `kortix-gha-eks-deploy-staging`
- Argo CD app: `kortix-staging`
- Gateway app: `kortix-gateway-staging`

Staging sizing should be closer to dev than prod by default, but use prod-like mechanics:

- EKS on-demand nodes, not Spot, to avoid false e2e failures from interruption;
- single NAT is acceptable until sustained staging load requires per-AZ NAT;
- API replica floor of 2 so rolling deploy and e2e runs exercise HA behavior;
- autoscale ceiling lower than prod;
- workers enabled only if staging has a fully separate staging DB/Supabase/project namespace;
- workers disabled if staging points at shared or prod-like data.

Recommended first staging settings:

| Setting | Value |
| --- | --- |
| EKS nodes | desired `2`, min `2`, max `5`, `m6i.large`, on-demand |
| API replicas | min `2`, max `4` |
| API resources | request `500m` / `1Gi`, limit `1` / `1Gi` |
| ECS fallback | desired `1`, min `1`, max `3`, no Spot |
| Worker router default | `ACTIVE_BACKEND=eks` |
| API env | `INTERNAL_KORTIX_ENV=staging` |

## Cloudflare

The Worker router has three environments:

- `prod`: `api.kortix.com`
- `staging`: `staging-api.kortix.com`
- `dev`: `dev-api.kortix.com`

Use a scoped Cloudflare API token for automation when possible. A global API key may be used only as an operator secret and must never be committed. Store Cloudflare credentials in one of:

- GitHub Actions secrets for CI/CD;
- local shell environment variables for one-off `wrangler` / Terraform runs;
- dotenvx-encrypted env files only when the value genuinely belongs to the app runtime.

Never place Cloudflare keys in:

- `.tfvars` committed to git;
- workflow YAML;
- docs;
- PR descriptions;
- shell history when avoidable.

## CI/CD

### Dev

`deploy-dev.yml` remains bound to `main`:

- build dev images;
- run dev DB migrations;
- bump `infra/k8s/envs/dev/*.yaml`;
- wait for dev EKS rollout;
- publish mutable dev CLI artifacts.

### Staging

`build-staging.yml` runs on every `staging` push:

- build API/gateway/frontend images for the exact staging SHA;
- tag them `staging-<sha8>`;
- tag `staging-latest` for manual inspection.

`deploy-staging.yml` deploys the staging release candidate after staging images
are built. It must first sync `kortix-staging-env` from staging secrets and run
node-pg-migrate against `STAGING_DATABASE_URL`; if that secret is missing or
points at dev/prod, the deploy must fail instead of falling back. The first
implementation isolates staging on the existing dev EKS control plane by
namespace, IAM role, secret bundle, hostnames, Worker route, and Vercel alias:

- `kortix-staging`
- `infra/k8s/envs/staging/*.yaml`
- `STAGING_DATABASE_URL`
- `staging-api-eks.kortix.com`
- `gateway-staging.kortix.com`

A separate physical `kortix-staging-eks` cluster remains the target upgrade when
cost and provisioning time justify it; the branch/release contract does not
change.

`qa-staging.yml` runs the heavier browser/e2e/migration checks after staging moves.

### Production

`promote.yml` defaults to `staging` as source. It must refuse promotion until the selected staging SHA is green.

`deploy-prod.yml` retags in this order:

1. `staging-<sha8>`
2. `dev-<sha8>` for legacy or dev-sourced releases
3. `dev-latest` only as a final legacy fallback

The long-term target is to remove fallback 2 and 3 after staging artifacts have existed across several successful releases.

## E2E Release Gate

The release gate has two layers:

1. `qa-staging.yml` after staging moves: validates the deployed staging target.
2. `qa-release.yml` on the release PR into `prod`: blocks production if the full release suite fails.

The live targets should be staging URLs, not production:

- `QA_API_BASE_URL=https://staging-api.kortix.com/v1`
- `QA_WEB_BASE_URL=https://staging.kortix.com`
- `QA_DAST_TARGET_URL=https://staging-api.kortix.com`
- `QA_PENTEST_TARGET_URL=https://staging-api.kortix.com`

The production promotion button should remain fast to start but strict to merge: it opens a PR, and branch protection on `prod` plus `qa-release` decides whether the release can land.

## Cutover Checklist

1. Create `staging` from the current `origin/main`.
2. Add the Worker `staging` env and deploy it after backend origins exist.
3. Add staging ECS Terraform from the dev/prod module pattern.
4. Add staging EKS cluster/platform Terraform from the dev-eks/prod-eks pattern.
5. Add `infra/k8s/envs/staging` values and Argo CD applications.
6. Add `deploy-staging.yml` once the cluster and roles exist.
7. Configure Vercel so `staging` deploys `staging.kortix.com`.
8. Configure GitHub vars/secrets for staging e2e.
9. Set branch protections:
   - `main`: direct pushes allowed, no force/delete.
   - `staging`: PR-based human changes plus bot GitOps pin commits, no force/delete.
   - `prod`: reviewed PR plus `qa-release`.
10. Run an end-to-end rehearsal:
    - push to `main`;
    - merge a PR into staging;
    - confirm staging images and staging QA;
    - promote staging to production;
    - confirm prod health reports the released version and source commit.

## Open Decisions

1. Whether staging gets a completely separate Supabase project from day one. This is strongly recommended; without it, workers should remain disabled on staging.
2. Whether staging should run in `us-west-2` for cost and operational parity with dev, or in prod's `eu-west-2` region to catch region-specific latency and IAM differences. Default recommendation: `us-west-2` first, `eu-west-2` only if prod-parity staging becomes necessary.
3. Whether direct human pushes to `staging` are allowed. Default recommendation: no; use normal PRs for human/code changes and allow only bot GitOps pin commits during deploy.
