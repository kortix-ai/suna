# Dev web on ECS Fargate

This stack owns the dedicated `kortix-dev-web` ECS service and its Cloudflare
records. It reads the existing Dev VPC and subnets. It uses a separate remote
state at `dev/ecs-web.tfstate`, so frontend changes cannot modify the Dev API or
gateway resources.

Apply the origin first:

```bash
terraform init
terraform apply -var='manage_origin_dns=true' -var='manage_canonical_dns=false'
```

After `https://dev-web-ecs-fargate.kortix.com` passes the health, Basic auth,
runtime-config, and application checks, apply the canonical cutover:

```bash
terraform apply -var='manage_origin_dns=true' -var='manage_canonical_dns=true'
```
