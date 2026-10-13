# Staging web on ECS Fargate, eu-west-2

The `kortix-staging-euw2-web` ECS service and its origin record
`staging-fe-ecs-euw2.kortix.com`. It reads the VPC from `../staging-eu-west-2`
and the `kortix-staging-euw2-web-env` secret in eu-west-2. Remote state:
`staging-eu-west-2/ecs-web.tfstate`. One on-demand task, scaling to four.

Its certificate covers `staging-fe-ecs.kortix.com` too. That record is a CNAME
that Deploy Staging's `publish-web-ecs-dns` job points at this root's ALB. This
stack never manages `staging.kortix.com` (Vercel).
