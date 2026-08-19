# Dev web on ECS Fargate

This stack owns the dedicated `kortix-dev-web` ECS service and its Cloudflare
records. It reads the existing Dev VPC and subnets. It uses a separate remote
state at `dev/ecs-web.tfstate`, so frontend changes cannot modify the Dev API or
gateway resources.

Apply the canonical ECS frontend:

```bash
terraform init
terraform apply
```

The stack owns `https://dev.kortix.com`. The Deploy Dev workflow also updates
this CNAME before it verifies the deployed frontend. Vercel is disabled for the
`main` branch.

The remote state owns the existing `dev.kortix.com` Cloudflare record at
`module.dns[0].cloudflare_record.this[\"dev\"]`. The cutover imported record
`e6511a4819a0f05dca09e275329ae1cb` in place. Do not create a second canonical
record or reintroduce the retired `dev-fe-ecs.kortix.com` alias.
