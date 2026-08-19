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

CI applies this root. `deploy-prod.yml` -> `terraform-prod-api` runs
`terraform-apply.yml` on every production release, before the released image
rolls onto ECS. There is no `terraform.tfvars`: every input is a committed
default in `variables.tf`, except `api_image`, which the release supplies.

To plan it by hand:

```bash
cd infra/terraform/environments/prod

export AWS_PROFILE=...                    # prod account creds
export TF_VAR_cloudflare_api_token=...

terraform init
terraform plan
```

## Notes

- `api_image` is supplied by the pipeline as `kortix/kortix-api:<version>` — the
  exact release being shipped, always immutable. The committed default is the
  moving `:latest` prod channel tag (retagged on every release) so a bare `plan`
  resolves to a real published image; do not replace it with a hard-coded
  version, which freezes at the release it was written on.
- Prod secrets live in the `kortix-prod-env` Secrets Manager blob, which
  `main.tf` passes as `secrets_blob_arn`. ECS injects the whole document as
  `KORTIX_ENV_JSON` and the execution role reads only that ARN.
- **`api_secrets` MUST include `MANAGED_GIT_GITHUB_TOKEN`** — the managed-git org
  PAT used by `POST /v1/projects/provision` to create repos under `managed-kortix`.
  Without it the code falls back to the GitHub App installation, which lacks
  Administration:write → `403 Resource not accessible by integration` → 502 on
  EVERY "Create project". `api_secrets` is inert while `secrets_blob_arn` is set
  (`modules/ecs-api/main.tf:459` enumerates the blob instead of each key), but the
  map is committed in full so dropping the blob cannot silently drop that key.
- Consider locking `alb_ingress_cidrs` (in the `ecs-api` module call) to
  Cloudflare's published IP ranges so the ALB only accepts proxied traffic.
- Use a separate remote state backend / AWS account from dev. `.tfvars` and
  state are gitignored; this root has neither a tfvars file nor an example.
- Deploys = push a new image tag + `aws ecs update-service --force-new-deployment`
  (rolling, min-healthy 100% / max 200%). `infra/scripts/ecs-deploy.sh` owns every
  task-definition revision after the first; the service ignores `task_definition`
  changes, so an apply never fights a deploy.
