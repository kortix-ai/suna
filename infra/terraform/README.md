# Kortix Infrastructure (Terraform)

Infrastructure-as-code for the Kortix API hosting. Each environment is a
separate root module under `environments/` with its own state.

> ⚠️ **Current runtime (2026-06-21):** prod = **EKS `kortix-prod-eks` (eu-west-2/London)**
> active; dev = **EKS `kortix-dev-eks` (us-west-2)** active. The **ECS Fargate stacks
> (`environments/{prod,dev}`) are the WARM STANDBY** the Cloudflare Worker fails over
> to — **NOT legacy, do not delete them.** Logs live in **Better Stack, not CloudWatch**.
> See **`infra/OBSERVABILITY.md`** for the full topology, the log tables, and the ECS
> standby restore runbook. (The env comments below are historical.)

```
infra/terraform/
  modules/
    network/           # shared VPC (public/private subnets + NAT)
    ecs-api/           # ECS Fargate API service behind an ALB
    acm-cloudflare/    # ACM cert validated via Cloudflare DNS
    cloudflare-dns/    # Cloudflare DNS records
    eks/               # EKS prod (cluster / platform / irsa) — see infra/EKS.md
  environments/
    dev/               # dev ECS warm-standby origin (dev-api-ecs-fargate)
    prod/              # prod ECS warm-standby origin (api-ecs-fargate)
    prod-eks/          # api-eks.kortix.com  (active EKS prod) — infra/EKS.md
```

> EKS is active; ECS remains available as the Cloudflare Worker standby. Full
> architecture + switch-back runbook: **`infra/EKS.md`**.

## Current topology

Dev and prod public API traffic are fronted by Cloudflare Workers and route to
EKS (`X-Backend: eks` on `/v1/health`, verified 2026-06-21). The ECS Fargate
environment modules remain in Terraform as warm standby origins for the Worker;
they are not legacy Lightsail adoption code and should not be deleted just
because EKS is active.

## State

State lives in S3 (`kortix-terraform-state`) with a DynamoDB lock table
(`kortix-terraform-locks`), both in us-west-2 — see `environments/*/backend.tf`.
Bootstrap once with `bash scripts/bootstrap-state.sh` (creates the bucket +
table if absent), then `terraform init`.

## Usage

```bash
cd infra/terraform/environments/dev
terraform init
terraform plan
terraform apply     # only after a clean plan
```

## What is NOT in Terraform (yet)

- **Cloudflare DNS / Worker plain-text vars** — some records and Worker vars are
  still operationally managed outside Terraform; verify live `X-Backend` before
  redeploying Worker defaults (see `infra/cloudflare/workers/api-router`).
- **Hosted frontend** (`dev.kortix.com`, `kortix.com`) — managed by Vercel's own
  GitHub integration, not Terraform.
