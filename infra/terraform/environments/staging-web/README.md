# Staging web on ECS Fargate

This stack owns the `kortix-staging-web` ECS service and
`staging-fe-ecs.kortix.com`. It reads the staging VPC, subnets, and
`kortix-staging-web-env` secret. It uses the remote state key
`staging/ecs-web.tfstate`.

The service starts with one on-demand Fargate task. CPU and memory target
tracking scale it from one to four tasks. The ECS deployment circuit breaker
rolls back unhealthy task revisions.

This stack never manages `staging.kortix.com`. Vercel remains active during
parallel validation.
