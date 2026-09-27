# dev-us-east-2 — dev's API/gateway, colocated with the dev database

Standing-up-before-tearing-down twin of `../dev`. Same module set, same
Fargate/Spot sizing, **different region (us-east-2, matching the dev
Supabase database's region)** and different resource names (`kortix-dev-use2`)
so it can exist alongside `../dev` (us-west-2) without any name collision —
IAM roles and the project-snapshots S3 bucket name are account/global-namespace
scoped, not region-scoped, so they cannot share `../dev`'s names while both are
live. See the apply runbook in PR #7844 for the full
rationale, apply sequence, and cutover/rollback.

| Surface | Where it runs | Managed by |
|---|---|---|
| `dev-api-use2-shadow.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | **this Terraform** |
| `gateway-dev-use2-shadow.kortix.com` | Cloudflare (proxied) → ALB → ECS Fargate (us-east-2) | **this Terraform** |

These are **shadow verification hostnames**. Production dev traffic
(`dev-api.kortix.com` / `dev-api-ecs-fargate.kortix.com`) is unaffected by this
root until the runbook's cutover step repoints those DNS records at this
root's ALB.

## Why this exists

Server-side `Server-Timing`, same code, same query counts:

| Route | dev (us-west-2 API / us-east-2 DB) | prod (colocated) |
| --- | --- | --- |
| `/accounts/me` | 2084 ms (db 2027 ms) | 24 ms (db 19 ms) |
| `/projects` | 1023 ms (db 1014 ms) | 45 ms (db 32 ms) |

7-13 sequential DB round trips per request, each crossing us-west-2 ↔
us-east-2. Moving the API to us-east-2 removes the cross-continent hop; it
does not remove the sequential-round-trip count (a separate, larger change).

## Apply

Not yet wired into `deploy-dev.yml` — this is a **new, not-yet-applied** root.
Follow the apply runbook in PR #7844 for the exact,
ordered `terraform init` / `plan` / `apply` sequence, required
`TF_VAR_secret_arn`-equivalent inputs, and the DNS cutover + decommission
steps that come after verification.

```bash
cd infra/terraform/environments/dev-us-east-2
export AWS_PROFILE=...                          # us-east-2 creds
export TF_VAR_cloudflare_api_token=...           # = CLOUDFLARE_API_TOKEN secret
terraform init
terraform plan
```

### Secrets

`kortix-dev-env` must be **replicated** to us-east-2 first (native Secrets
Manager cross-region replication — same secret name, same content, a
region-specific ARN; the source of truth stays the us-west-2 secret). See the
runbook. `data "aws_secretsmanager_secret" "env"` resolves the replica
automatically once the provider region is `us-east-2` and the name matches.

### Image

Same convention as `../dev`: `api_image` defaults to the moving
`:dev-latest` tag; CI (once wired) would pass the exact `dev-<sha8>` tag it
just published.

> ⚠️ `terraform apply` here creates real, billable AWS resources (VPC, NAT,
> ALB × 2, Fargate). It does not touch anything in `../dev`.
