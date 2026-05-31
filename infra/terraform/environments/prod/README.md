# prod environment — `api.kortix.com` on ECS Fargate (autoscaled, HA)

The **same modules as dev** (`../dev`), with prod-grade numbers. Bringing prod
up is the same workflow as dev — only the variables differ.

| Setting | dev | prod |
|---|---|---|
| Task size | 512 / 1024 | 1024 / 2048 |
| desired / min / max | 1 / 1 / 3 | 2 / **2** / 10 |
| Fargate Spot | yes | no |
| NAT gateways | 1 (shared) | 1 per AZ (HA) |
| Container Insights | off | on |
| CPU / mem scaling target | 60% / 70% | 55% / 65% |

`min_capacity = 2` across 2 AZs gives prod the availability + horizontal
autoscaling expected for SOC 2.

## Apply

```bash
cd infra/terraform/environments/prod

export AWS_PROFILE=...                    # prod account creds
export TF_VAR_cloudflare_api_token=...
export TF_VAR_cloudflare_zone_id=...

cp terraform.tfvars.example terraform.tfvars   # PIN api_image to a release; secret ARNs
terraform init
terraform plan
terraform apply
```

## Notes

- Pin `api_image` to an immutable release tag/sha — never `:latest` in prod.
- Store prod secrets in Secrets Manager (separate from dev); reference ARNs in
  `api_secrets`. The execution role reads only those ARNs.
- Consider locking `alb_ingress_cidrs` (in the `ecs-api` module call) to
  Cloudflare's published IP ranges so the ALB only accepts proxied traffic.
- Use a separate remote state backend / AWS account from dev. `.tfvars` and
  state are gitignored.
- Deploys = push a new image tag + `aws ecs update-service --force-new-deployment`
  (rolling, min-healthy 100% / max 200%), or bump `api_image` and `apply`.
