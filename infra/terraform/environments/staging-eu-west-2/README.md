# staging-eu-west-2 — staging's API/gateway, colocated with the staging DB

Standing-up-before-tearing-down twin of `../staging`. Same module set, same
Fargate/Spot sizing, **different region (eu-west-2, matching the staging
Supabase database's region and matching prod's own topology)**, different
resource names (`kortix-staging-euw2`). See
the apply runbook in PR #7844 for rationale, apply
sequence, and cutover/rollback.

| Surface | Where it runs | Managed by |
|---|---|---|
| `staging-api-euw2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | **this Terraform** |
| `gateway-staging-euw2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | **this Terraform** |
| `staging-fe-ecs-euw2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | `../staging-web-eu-west-2` |

These are origin hostnames. `staging-api.kortix.com` is the staging-api Worker;
its `ACTIVE_BACKEND` picks the origin. `staging-fe-ecs.kortix.com` is a CNAME
that Deploy Staging points at the web ALB. Vercel serves `staging.kortix.com`
and is not part of this move.

## Why this exists

Server-side `Server-Timing`, same code, same query counts:

| Route | staging (us-west-2 API / eu-west-2 DB) | prod (colocated) |
| --- | --- | --- |
| Same class as dev's measured 24-85x amplification (see `../dev-us-east-2/README.md`) | | |

Staging also carries the release gate's full concurrent test load
(`pnpm test -- --target-full`), so the cross-region DB hop is paid by every
one of that suite's 441 REST flows + 21 Playwright journeys, not just by
humans.

Unlike `../dev-us-east-2`, eu-west-2 has **no pre-existing `*.kortix.com`
wildcard cert** (prod's own `main.tf` notes this), so this root requests two
dedicated per-domain ACM certs (api + gateway) — same pattern `../prod` uses,
not the wildcard-reuse shortcut `../dev-us-east-2` gets from the
`prod-us-east-2-shadow` cert that already exists in us-east-2.

## Switch-over runbook

The same four phases as `../dev-us-east-2/README.md`, with these names:

| | dev | staging |
|---|---|---|
| deploy target (`ecs-deploy.sh`) | `dev-use2` | `staging-euw2` |
| secrets | `kortix-dev-env`, `kortix-dev-web-env` → `kortix-dev-use2-web-env` | `kortix-staging-env`, `kortix-staging-web-env` → `kortix-staging-euw2-web-env` |
| copy | `us-west-2` → `us-east-2` | `us-west-2` → `eu-west-2` |
| web root | `../dev-web-us-east-2` | `../staging-web-eu-west-2` |
| live web record | `dev` | `staging-fe-ecs` |
| audit archive to copy (Phase 4, "Data") | 622 objects, copied 2026-10-09 | none: `kortix-staging-audit-archive` was empty on 2026-10-09 |

Staging differs from dev in two ways:

1. **Deploy Staging runs from the `staging` branch** and rewrites the Worker
   bindings on every run (`deploy-staging.yml`, the `ACTIVE_BACKEND` binding
   list). The switch is permanent only once it is on `staging`; a manual
   Worker change alone is reverted by the next staging release.
2. **The staging database allows 120 connections.** One API task holds up to 8
   (`DB_POOL_MAX` 4 + audit 2 + leader 1 + broadcast 1). The old stack's 6
   tasks plus a 6-task new stack and a rolling deploy exceed the limit, so
   apply this root with `TF_VAR_api_task_count=2` while `../staging` runs.

Order:

1. Apply with `api_task_count=2`, roll the current staging images with
   `ecs-deploy.sh staging-euw2`, verify on the origin hostnames.
2. Merge the switch code into `dev` (Worker `eu-west-2` slot, Deploy Staging
   targets `staging-euw2`, IAM for the `kortix-staging-euw2-*` roles and the
   eu-west-2 `kortix-staging-env` write).
3. Switch by hand: `--workers on` for the eu-west-2 copy and roll the new API;
   point the staging Worker's `BACKEND_ECS_FARGATE` binding at
   `https://staging-api-euw2.kortix.com` (gateway: `gateway-staging-euw2`);
   scale `kortix-staging`, `kortix-staging-gateway` and `kortix-staging-web`
   (us-west-2) to 0.
4. Promote `dev` to `staging` (release gate, needs approval). Deploy Staging
   then applies these roots at `api_task_count` 6 and writes the `eu-west-2`
   binding.

> ⚠️ `terraform apply` here creates real, billable AWS resources (VPC, NAT,
> ALB × 2, Fargate). It does not touch anything in `../staging`.
