# Dev web on ECS Fargate, us-east-2

The `kortix-dev-use2-web` ECS service and its origin record
`dev-use2.kortix.com`. It reads the VPC from `../dev-us-east-2` and the
`kortix-dev-use2-web-env` secret in us-east-2. Remote state:
`dev-us-east-2/ecs-web.tfstate`.

`dev.kortix.com` is a CNAME that Deploy Dev's `publish-web-ecs-dns` job points
at this root's ALB. Apply this root after `../dev-us-east-2`.
