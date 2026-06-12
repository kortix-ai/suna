# Kortix Infrastructure (Terraform)

Infrastructure-as-code for the Kortix API hosting. Each environment is a
separate root module under `environments/` with its own state.

```
infra/terraform/
  modules/
    api-host/          # legacy: a Lightsail box that serves the kortix-api
    network/           # shared VPC (public/private subnets + NAT)
    ecs-api/           # ECS Fargate API service behind an ALB
    acm-cloudflare/    # ACM cert validated via Cloudflare DNS
    cloudflare-dns/    # Cloudflare DNS records
    eks/               # EKS prod (cluster / platform / irsa) — see infra/EKS.md
  environments/
    dev/               # dev-api.kortix.com  (ECS, us-west-2)
    prod/              # api-prod.kortix.com (ECS)
    prod-eks/          # api-eks.kortix.com  (EKS, parallel to prod) — infra/EKS.md
```

> The EKS prod stack runs **in parallel** with ECS and never touches it. Full
> architecture + bring-up + switch-back runbook: **`infra/EKS.md`**.

## Why Lightsail (today) → ECS (later)

The dev + prod APIs currently run as Docker containers on AWS **Lightsail**
instances behind nginx (blue/green on ports 8008/8009), deployed over SSH by
`.github/workflows/deploy-dev.yml` / `release.yml`. This Terraform **adopts the
existing live boxes** (via `terraform import`) so the infra is reproducible and
the nginx/keepalive config can't be lost on a rebuild — it does NOT recreate
them. The longer-term SOC2 target (autoscaling, no OS to patch) is ECS Fargate
+ ALB; that migration is a separate environment module added once dev is stable.

## State

State lives in S3 (`kortix-terraform-state`) with a DynamoDB lock table
(`kortix-terraform-locks`), both in us-west-2 — see `environments/*/backend.tf`.
Bootstrap once with `bash scripts/bootstrap-state.sh` (creates the bucket +
table if absent), then `terraform init`.

## Usage

```bash
cd infra/terraform/environments/dev
terraform init
terraform plan      # should show NO changes against the live box
terraform apply     # only after a clean plan
```

## Importing the existing dev box (one-time)

Already-running resources are adopted, never recreated:

```bash
cd infra/terraform/environments/dev
bash import.sh      # imports the Lightsail instance, static IP, attachment, ports
terraform plan      # confirm parity (empty/near-empty diff)
```

## What is NOT in Terraform (yet)

- **Cloudflare DNS** (`dev-api.kortix.com` → box IP, orange-cloud) — needs a
  `CLOUDFLARE_API_TOKEN`; wired as an optional module, disabled until the token
  is provided as `TF_VAR_cloudflare_api_token`.
- **The Vercel frontend** (dev.kortix.com) — managed by Vercel's own GitHub
  integration, not Terraform.
- **In-box provisioning** (nginx config, Docker, deploy scripts) — currently
  applied via `cloud-init`/user-data is NOT retroactively settable on a running
  Lightsail box; the canonical nginx config is committed at
  `modules/api-host/files/nginx-kortix-api.conf` so a rebuild restores it.
