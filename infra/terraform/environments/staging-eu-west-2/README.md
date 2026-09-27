# staging-eu-west-2 — staging's API/gateway, colocated with the staging DB

Standing-up-before-tearing-down twin of `../staging`. Same module set, same
Fargate/Spot sizing, **different region (eu-west-2, matching the staging
Supabase database's region and matching prod's own topology)**, different
resource names (`kortix-staging-euw2`). See
the apply runbook in PR #7844 for rationale, apply
sequence, and cutover/rollback.

| Surface | Where it runs | Managed by |
|---|---|---|
| `staging-api-euw2-shadow.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | **this Terraform** |
| `gateway-staging-euw2-shadow.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (eu-west-2) | **this Terraform** |

Shadow verification hostnames only. `staging-api.kortix.com` / the release
gate keep hitting `../staging` (us-west-2) until the runbook's cutover step.

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

## Apply

Not yet wired into `deploy-staging.yml` — follow
the apply runbook in PR #7844.

```bash
cd infra/terraform/environments/staging-eu-west-2
export AWS_PROFILE=...                          # eu-west-2 creds
export TF_VAR_cloudflare_api_token=...
terraform init
terraform plan
```

### Secrets

`kortix-staging-env` must be replicated to eu-west-2 first (native Secrets
Manager cross-region replication). See the runbook.

> ⚠️ `terraform apply` here creates real, billable AWS resources (VPC, NAT,
> ALB × 2, Fargate). It does not touch anything in `../staging`.
