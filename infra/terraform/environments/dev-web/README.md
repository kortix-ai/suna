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

The first cutover requires a state migration because the previous stack owned
`dev-fe-ecs.kortix.com`. Import the existing `dev.kortix.com` Cloudflare record
into `module.dns.cloudflare_record.records[\"dev\"]` before the next apply. Then
remove the old `dev-fe-ecs` state entry after confirming the alias is no longer
required. Do not apply a plan that attempts to create a duplicate canonical
record.
