# Staging web on ECS Fargate, eu-west-2

The `kortix-staging-euw2-web` ECS service and its origin record
`staging-fe-ecs-euw2.kortix.com`. It reads the VPC from `../staging-eu-west-2`
and the `kortix-staging-euw2-web-env` secret in eu-west-2. Remote state:
`staging-eu-west-2/ecs-web.tfstate`. One on-demand task, scaling to four.

Its certificate covers `staging-fe-ecs.kortix.com` too, so the same ALB serves
after the switch-over. `staging-fe-ecs.kortix.com` stays on `../staging-web`
until then. The runbook is in `../staging-eu-west-2/README.md`. This stack never
manages `staging.kortix.com` (Vercel).
