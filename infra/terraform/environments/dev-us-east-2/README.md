# dev-us-east-2 — dev's API/gateway, colocated with the dev database

Twin of `../dev` that stands up before `../dev` is torn down. Same module set,
same Fargate Spot sizing, **different region (us-east-2, the dev Supabase
database's region)** and different resource names (`kortix-dev-use2`), so it
runs next to `../dev` (us-west-2) without a name collision. IAM roles and S3
bucket names are global, so the two stacks cannot share names while both live.
`../dev-web-us-east-2` is the matching web service.

| Surface | Where it runs | Managed by |
|---|---|---|
| `dev-api-use2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | **this Terraform** |
| `gateway-dev-use2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | **this Terraform** |
| `dev-use2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | `../dev-web-us-east-2` |

These are origin hostnames. `dev-api.kortix.com` and `gateway-dev.kortix.com`
are the dev-api Worker (`infra/cloudflare/workers/api-router`). Its
`ACTIVE_BACKEND` picks the origin: `ecs-fargate` = `../dev`, `us-east-2` = this
root. `dev.kortix.com` is a CNAME that Deploy Dev's `publish-web-ecs-dns` job
points at the web ALB.

## Why this exists

Server-side `Server-Timing`, same code, same query counts:

| Route | dev (us-west-2 API / us-east-2 DB) | prod (colocated) |
| --- | --- | --- |
| `/accounts/me` | 2084 ms (db 2027 ms) | 24 ms (db 19 ms) |
| `/projects` | 1023 ms (db 1014 ms) | 45 ms (db 32 ms) |

7-13 sequential DB round trips per request, each crossing us-west-2 ↔
us-east-2. Moving the API to us-east-2 removes the cross-continent hop; it
does not remove the sequential-round-trip count (a separate, larger change).

## Switch-over runbook

Nothing below moves data. The dev database stays where it is. The snapshot
bucket and the config-release archives are caches that the API rebuilds from
Git (`apps/api/src/config-releases/store.ts`), so the new buckets start empty.
Every `terraform apply`, Worker change and delete needs an approved plan.

**Background workers.** The singleton loops (cron triggers, maintenance,
migration workers) run on the one replica that holds the lease row in
`kortix.worker_leader_lease` (`apps/api/src/shared/leader-election.ts`). Both
stacks share the database, so they share the lease. The new stack still starts
with `KORTIX_WORKERS_ENABLED=false`, so an unverified stack never takes the
lease.

### Phase 1 — stand up (dev keeps serving from `../dev`)

1. Copy the env blobs to us-east-2. The script prints key names only.

   ```bash
   infra/scripts/copy-env-secret.sh kortix-dev-env us-west-2 us-east-2 --workers off
   infra/scripts/copy-env-secret.sh kortix-dev-web-env us-west-2 us-east-2 --to-name kortix-dev-use2-web-env
   ```

   Until phase 4, an edit to `kortix-dev-env` goes to both copies. `--check`
   names the keys that drifted.
2. Plan this root, then `../dev-web-us-east-2` (it reads this root's VPC).
   `TF_VAR_cloudflare_api_token` is `CLOUDFLARE_API_TOKEN` in `kortix-ci-env`.

   ```bash
   terraform init && terraform plan -out=plan.tfplan   # read it, then apply
   ```

3. Roll the real task definitions. Terraform only seeds the services; the
   deploy script renders the env from the secret. The overrides are the
   `deploy-api-ecs` job's, with the new bucket names and region:

   ```bash
   export KORTIX_ECS_ENV_OVERRIDES="$(grep -m1 -A1 'KORTIX_ECS_ENV_OVERRIDES: >-' .github/workflows/deploy-dev.yml | tail -1 \
     | sed -E 's/kortix-dev-(project-snapshots|audit-archive)/kortix-dev-use2-\1/g; s/"us-west-2"/"us-east-2"/g; s/^ +//')"
   bash infra/scripts/ecs-deploy.sh dev-use2 kortix/kortix-api:dev-<sha8> --wait-for serving
   bash infra/scripts/ecs-deploy.sh dev-use2 kortix/kortix-gateway:dev-<sha8> --service gateway
   KORTIX_ECS_ENV_OVERRIDES= bash infra/scripts/ecs-deploy.sh dev-use2 kortix/kortix-frontend:dev-<sha8> --service web
   ```

4. Verify on the origins: `https://dev-api-use2.kortix.com/v1/health`,
   `https://gateway-dev-use2.kortix.com/health/live`, `https://dev-use2.kortix.com`,
   and real sessions on both harnesses with the CLI pointed at
   `https://dev-api-use2.kortix.com`.

### Phase 2 — switch

1. `copy-env-secret.sh kortix-dev-env us-west-2 us-east-2 --check` must print
   `in sync`. Re-copy with `--workers off` when it does not.
2. In the old dev-web state, drop the `dev` record so `../dev-web` can neither
   revert nor delete it:
   `terraform -chdir=infra/terraform/environments/dev-web state rm 'module.dns[0].cloudflare_record.this["dev"]'`.
3. Merge the switch PR: Worker `[env.dev.vars]` gets `BACKEND_US_EAST_2` /
   `GATEWAY_BACKEND_US_EAST_2` and `ACTIVE_BACKEND = "us-east-2"`; Deploy Dev
   targets `dev-use2`, us-east-2, these roots and the new buckets. Deploy Dev
   then repoints `dev.kortix.com`.
4. Workers: `--workers on` for the us-east-2 copy and redeploy the new API, then
   set `KORTIX_WORKERS_ENABLED=false` in the us-west-2 copy and redeploy `dev`.
   The lease moves within 60 s.
5. Verify dev end to end.

**Undo:** `wrangler deploy --env dev --var ACTIVE_BACKEND:ecs-fargate --var
GATEWAY_ACTIVE_BACKEND:ecs-fargate`, `node infra/scripts/sync-web-dns.mjs dev
<kortix-dev-web-alb DNS name>`, and swap the two workers flags back. Both stacks
use one database, so nothing diverges.

### Phase 3 — idle the old stack

After 24 hours of clean traffic, scale `kortix-dev`, `kortix-dev-gateway` and
`kortix-dev-web` (us-west-2) to 0 tasks. Undo is then `ecs-deploy.sh dev
<current image>` plus the steps above (~2-3 min).

### Phase 4 — decommission (3-7 days after the switch)

Destroy `../dev` and `../dev-web` (read the destroy plan first), delete the
us-west-2 `kortix-dev-env` and `kortix-dev-web-env`, and add this root and
`../dev-web-us-east-2` to the drift-plan matrix in
`.github/workflows/terraform-ci.yml`.

> ⚠️ `terraform apply` here creates billable AWS resources (VPC, NAT, 2 ALBs,
> Fargate). It does not touch anything in `../dev`.
