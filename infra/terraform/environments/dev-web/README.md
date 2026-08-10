# Dev web on ECS Fargate

This stack owns the dedicated `kortix-dev-web` ECS service and its Cloudflare
records. It reads the existing Dev VPC and subnets. It uses a separate remote
state at `dev/ecs-web.tfstate`, so frontend changes cannot modify the Dev API or
gateway resources.

Apply the parallel ECS frontend:

```bash
terraform init
terraform apply
```

The stack creates `https://dev-fe-ecs.kortix.com`. It never reads, changes, or
deletes `dev.kortix.com`. The canonical Dev frontend remains on Vercel.
