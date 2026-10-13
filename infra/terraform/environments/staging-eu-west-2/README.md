# staging-eu-west-2 — staging's API/gateway, colocated with the staging DB

Staging's API and gateway on ECS Fargate in eu-west-2, the staging Supabase
database's region and prod's own topology. Resource names use
`kortix-staging-euw2`. The original apply runbook is in PR #7844.

| Surface | Where it runs | Managed by |
|---|---|---|
| `staging-api-euw2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | **this Terraform** |
| `gateway-staging-euw2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | **this Terraform** |
| `staging-fe-ecs-euw2.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | `../staging-web-eu-west-2` |

These are origin hostnames. `staging-api.kortix.com` is the staging-api Worker,
which routes to them (`ACTIVE_BACKEND = "eu-west-2"`). Deploy Staging rewrites
the Worker bindings on every run (`deploy-staging.yml`), so a manual Worker
change lasts only until the next staging deploy. `staging-fe-ecs.kortix.com` is
a CNAME that Deploy Staging points at the web ALB. Vercel serves
`staging.kortix.com`.

Deploy Staging applies this root (`terraform-staging`) and rolls the task
definitions with `infra/scripts/ecs-deploy.sh staging-euw2`. The env blob is
`kortix-staging-env` in eu-west-2.

**The staging database allows 120 connections.** One API task holds up to 9.
Keep `api_task_count` × 9 plus a rolling deploy's extra tasks under that limit.

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
not the shortcut `../dev-us-east-2` uses (a `*.kortix.com` validation record
already in the zone).

## The move from us-west-2 (done)

Staging ran in us-west-2 (Terraform roots `staging` and `staging-web`, now
deleted) until the move. It followed the same four phases
as dev (`../dev-us-east-2/README.md`).

- 2026-10-06: the old `kortix-staging`, `kortix-staging-gateway` and
  `kortix-staging-web` services were scaled to 0.
- 2026-10-12: the old roots were destroyed (staging 74, staging-web 19
  resources) and removed from the repository. The old snapshot cache
  `kortix-staging-project-snapshots` (a cache, last write 2026-10-06) and the
  empty `kortix-staging-audit-archive` were deleted with the root. The
  us-west-2 copies of `kortix-staging-env` and `kortix-staging-web-env` were
  scheduled for deletion (30-day recovery window).

> ⚠️ `terraform apply` here creates real, billable AWS resources (VPC, NAT,
> ALB × 2, Fargate).
