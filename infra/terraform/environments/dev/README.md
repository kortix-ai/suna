# dev environment — `dev-api.kortix.com` on ECS Fargate (autoscaled)

| Surface | Where it runs | Managed by |
|---|---|---|
| `dev-api.kortix.com` | Cloudflare (proxied) → ALB → **ECS Fargate** (autoscaled, private subnets, NAT egress) | **this Terraform** |
| `dev.kortix.com` (frontend) | Cloudflare (proxied) → ALB → **ECS Fargate** | `../dev-web` Terraform |

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

CI applies this root. `deploy-dev.yml` -> `terraform-dev-api` runs
`terraform-apply.yml` on every push to `main` that touches a dev root,
`modules/**`, or either workflow, before the API image rolls onto ECS. There is
no `terraform.tfvars`: every input is a committed default in `variables.tf`.

To plan it by hand:

```bash
cd infra/terraform/environments/dev

export AWS_PROFILE=...                          # us-west-2 creds
export TF_VAR_cloudflare_api_token=...           # = CLOUDFLARE_API_TOKEN secret

terraform init                                   # bootstrap S3 state first (../../scripts/bootstrap-state.sh)
terraform plan
```

### Secrets

App secrets are **not** in Terraform. The dev bundle lives in the
`kortix-dev-env` Secrets Manager blob, which `main.tf` passes to the module as
`secrets_blob_arn`; ECS injects the whole document as `KORTIX_ENV_JSON` and the
execution role can read only that ARN. `api_secrets` holds the per-key ARNs of
the same blob and is currently inert (`modules/ecs-api` reads it only when
`secrets_blob_arn` is empty). Non-secret config goes in `api_environment`.
`container_port` (8008) must match the port the image binds — it is injected as
`PORT` and it sets the ALB target-group port, which forces replacement when it
changes.

### Image

`api_image` is the one input CI supplies, not a committed value:
`deploy-dev.yml` passes the `kortix/kortix-api:dev-<sha8>` tag the same run
published. The committed default is the moving `:dev-latest` channel tag, so a
bare `plan` still resolves to a real published image.

> ⚠️ `terraform apply` here changes real, billable AWS resources (ALB + NAT +
> Fargate).

## Notes

- `.terraform/`, `*.tfstate`, lockfile, and `*.tfvars` are gitignored. This root
  has no tfvars file and no `terraform.tfvars.example`: everything is a
  committed default so CI plans exactly what an operator plans.
- Logs: CloudWatch `/ecs/kortix-dev`. Scaling activity: the ECS service's
  Deployments/events + Application Auto Scaling history.
