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

Staging's switch PR also needs three changes dev does not:

1. The Worker has no eu-west-2 slot. Add `'eu-west-2': env.BACKEND_EU_WEST_2`
   (and the gateway twin) to `worker.mjs`, then set `ACTIVE_BACKEND =
   "eu-west-2"`. Deploy Staging writes the Worker's bindings itself
   (`deploy-staging.yml`, the `ACTIVE_BACKEND` binding list), so change them
   there too.
2. Deploy Staging writes `kortix-staging-env` on every run. The deploy role may
   write it in us-west-2 only
   (`infra/terraform/security-baseline/iam-gha-ecs-deploy.tf`). Grant
   eu-west-2 before the workflow targets it.
3. Start staging only after dev has run on us-east-2 for 3 days without an
   incident.

> ⚠️ `terraform apply` here creates real, billable AWS resources (VPC, NAT,
> ALB × 2, Fargate). It does not touch anything in `../staging`.
