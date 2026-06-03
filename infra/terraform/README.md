# Kortix Infrastructure (Terraform)

Infrastructure-as-code for the Kortix API hosting. Each environment is a
separate root module under `environments/` with its own state.

```
infra/terraform/
  modules/
    acm-cloudflare/    # ACM certs validated through Cloudflare DNS
    cloudflare-dns/    # Cloudflare DNS records
    ecs-api/           # ECS Fargate API service + ALB + autoscaling
    network/           # VPC, subnets, NAT, and security groups
  environments/
    dev/               # dev-api.kortix.com
    prod/              # api.kortix.com
```

## Runtime Model

The API environments are ECS Fargate services behind ALBs. Terraform owns the
network, certificates, load balancers, ECS services, autoscaling, and optional
Cloudflare DNS records. CI owns image builds and service rolls.

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

## What is NOT in Terraform (yet)

- **The Vercel frontend** (dev.kortix.com) — managed by Vercel's own GitHub
  integration, not Terraform.
- **Application secrets** — store them in AWS Secrets Manager or SSM and pass
  ARNs through each environment's `api_secrets` map.
