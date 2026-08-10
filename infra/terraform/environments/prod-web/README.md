# Production web on ECS Fargate

This stack owns the `kortix-prod-web` ECS service and
`prod-fe-ecs.kortix.com`. It reads the production VPC, subnets, and
`kortix-prod-web-env` secret. It uses the remote state key
`prod/ecs-web.tfstate`.

The service starts with two on-demand Fargate tasks across private subnets.
CPU and memory target tracking scale it from two to twelve tasks. The ECS
deployment circuit breaker rolls back unhealthy task revisions.

This stack never manages `kortix.com`. Vercel remains active during parallel
validation. Production protection is disabled in the rendered web profile.
