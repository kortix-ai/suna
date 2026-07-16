# api-router — the public API blue/green switch

Cloudflare Worker that fronts the public API hostnames and forwards to whichever
backend `ACTIVE_BACKEND` names. One source (`worker.mjs`), three envs (`wrangler.toml`):

| Env    | Custom domain        | Worker script           | `eks` backend          | `ecs-fargate` backend          |
| ------ | -------------------- | ----------------------- | ---------------------- | ------------------------------ |
| `prod` | `api.kortix.com`     | `api-kortix-router`     | `api-eks.kortix.com`     | `api-ecs-fargate.kortix.com`     |
| `staging` | `staging-api.kortix.com` | `staging-api-kortix-router` | `staging-api-eks.kortix.com` | `staging-api-ecs-fargate.kortix.com` |
| `dev`  | `dev-api.kortix.com` | `dev-api-kortix-router` | `dev-api-eks.kortix.com` | `dev-api-ecs-fargate.kortix.com` |

**ECS Fargate is the ACTIVE backend for prod and dev** (`ACTIVE_BACKEND` /
`GATEWAY_ACTIVE_BACKEND` = `ecs-fargate` since PR #4683); EKS is the warm
standby. **Staging is the exception: EKS-active** — `deploy-staging.yml`'s
wire-cloudflare job re-asserts `ACTIVE_BACKEND=eks` on every staging rollout.
CI always deploys BOTH backends in lockstep: the ECS task-defs via
`infra/scripts/ecs-deploy.sh` (rendered from the per-env Secrets Manager blob,
with `KORTIX_VERSION` stamped so both sides report identical versions) and the
EKS services via Argo CD GitOps (`deploy-dev.yml` / `deploy-staging.yml` /
`deploy-prod.yml`). On prod, `deploy-prod.yml`'s `verify-live-version` job
asserts the public hosts serve the released version before anything announces.
Background-worker leadership is guarded by a single global DB lease
(`apps/api/src/shared/leader-election.ts`), so only one side ever runs cron.

The checked-in Worker vars are deploy defaults; the live Worker plain-text var is
the runtime source of truth. If a checked-in default disagrees with the live
`X-Backend` header, fix the config drift before redeploying the Worker (tracking:
https://github.com/kortix-ai/suna/issues/3629).

## Deploy (code or var changes)

```bash
# auth: scoped CLOUDFLARE_API_TOKEN, or CI's CLOUDFLARE_EMAIL + CLOUDFLARE_GLOBAL_API_KEY REST fallback
wrangler deploy --env prod      # api.kortix.com
wrangler deploy --env staging   # staging-api.kortix.com
wrangler deploy --env dev       # dev-api.kortix.com
```

## Fail over (no code change) — flip the active backend

```bash
# prod → EKS standby, then back to ECS Fargate (the normal active backend)
wrangler deploy --env prod --var ACTIVE_BACKEND:eks
wrangler deploy --env prod --var ACTIVE_BACKEND:ecs-fargate
```

Or set the `ACTIVE_BACKEND` plain-text var in the Cloudflare dashboard. Verify
with the `X-Backend` response header on `/v1/health`:

```bash
curl -s -D - https://api.kortix.com/v1/health -o /dev/null | grep -i x-backend
```

## Backend hostnames (proxied CNAMEs → ALBs, Full-strict TLS)

- `*-eks` → the EKS ALB (served by the kortix-api Helm chart ingress).
- `*-ecs-fargate` → the ECS Fargate ALB (Terraform `environments/{dev,prod}`,
  `extra_api_hostnames` / `local.domain`). Each clean name has its own ACM cert
  on the ALB so Cloudflare Full-strict to origin validates.
