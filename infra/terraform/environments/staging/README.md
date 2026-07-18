# dev environment — `dev-api.kortix.com` on ECS Fargate (autoscaled)

| Surface | Where it runs | Managed by |
|---|---|---|
| `dev-api.kortix.com` | Cloudflare (proxied) → ALB → **ECS Fargate** (autoscaled, private subnets, NAT egress) | **this Terraform** |
| `dev.kortix.com` (frontend) | Vercel | Vercel's own Git integration |

The **same module set prod uses** (`../prod`) — dev just runs smaller numbers
and Fargate Spot. App code still ships via CI (`deploy-dev.yml`); Terraform owns
the infra (network, ALB, ECS, DNS), not the running image.

## Architecture

```
Cloudflare (proxied, Full strict)
        │  TLS
        ▼
  ALB  (public subnets, ACM cert via Cloudflare DNS validation)
        │  HTTP :PORT
        ▼
  ECS Fargate service  (private subnets, egress via NAT)
   ├─ target-tracking autoscaling: CPU 60% + memory 70%
   └─ desired 1, min 1, max 3, FARGATE_SPOT   (prod: 2 / 2 / 10, on-demand)
```

Modules: `network` (VPC + public/private subnets + NAT), `acm-cloudflare` (ACM
cert validated via Cloudflare DNS), `ecs-api` (cluster + ALB + service +
autoscaling), `cloudflare-dns` (the `dev-api` CNAME → ALB).

## Apply

```bash
cd infra/terraform/environments/dev

export AWS_PROFILE=...                          # us-west-2 creds
export TF_VAR_cloudflare_api_token=...           # = CLOUDFLARE_API_TOKEN secret
export TF_VAR_cloudflare_zone_id=$(curl -s \
  -H "Authorization: Bearer $TF_VAR_cloudflare_api_token" \
  'https://api.cloudflare.com/client/v4/zones?name=kortix.com' | jq -r '.result[0].id')

cp terraform.tfvars.example terraform.tfvars     # fill in image + secret ARNs
terraform init                                   # bootstrap S3 state first (../../scripts/bootstrap-state.sh)
terraform plan
terraform apply
```

### Secrets

App secrets are **not** in Terraform. Store the dev secret bundle in AWS Secrets
Manager and reference each key's ARN in `api_secrets` (see
`terraform.tfvars.example`). The execution role is granted read on exactly those
ARNs. Non-secret config goes in `api_environment`. `container_port` must match
the port the image binds (it's also injected as `PORT`).

### Image

`api_image` defaults to `ghcr.io/kortix-ai/kortix-api:latest`. For a private
GHCR image, add `repositoryCredentials` to the task def or mirror into ECR. Pin
to a tag/sha for reproducible deploys.

> ⚠️ `terraform apply` here creates real, billable AWS resources (ALB + NAT +
> Fargate). Nothing applies automatically.

## Notes

- `.terraform/`, `*.tfstate`, lockfile, and `*.tfvars` are gitignored
  (`terraform.tfvars.example` is committed).
- Logs: CloudWatch `/ecs/kortix-dev`. Scaling activity: the ECS service's
  Deployments/events + Application Auto Scaling history.
