# ecs-api — autoscaling Kortix API on ECS Fargate + ALB

The `kortix-api` container running as an **ECS Fargate** service behind an
**Application Load Balancer**, horizontally **autoscaled** (target-tracking on
CPU **and** memory). One module, used by both `environments/dev` and
`environments/prod` — only the variables differ, so promoting to prod is "the
same thing with bigger numbers and `min_capacity >= 2`".

## What it creates

- ECS cluster (Container Insights optional) + Fargate service, on `FARGATE` or
  `FARGATE_SPOT` (`use_fargate_spot`, good for dev).
- ALB in public subnets; tasks in private subnets (SG locks tasks to ALB only).
- HTTPS listener when `certificate_arn` is set (HTTP→HTTPS redirect); plain HTTP
  otherwise.
- Target-tracking autoscaling: CPU (`cpu_target`) + memory (`memory_target`),
  between `min_capacity` and `max_capacity`.
- Rolling deploys with the ECS **deployment circuit breaker** (auto-rollback on
  a bad release); `task_definition` + `desired_count` are `ignore_changes` so CI
  (new task-def revisions) and autoscaling (the count) own them at runtime.
- CloudWatch log group `/ecs/<name>`, IAM execution + task roles. Secrets are
  injected from Secrets Manager / SSM ARNs (`secrets`) — never hardcoded.

## Inputs of note

- `name` — resource prefix (e.g. `kortix-dev`).
- `vpc_id` / `public_subnet_ids` / `private_subnet_ids` — from `modules/network`.
- `image`, `container_port` (also injected as `PORT`), `environment`, `secrets`.
- `task_cpu` / `task_memory`, `desired_count`, `min_capacity` / `max_capacity`,
  `cpu_target` / `memory_target`.
- `certificate_arn` — ACM cert (see `modules/acm-cloudflare`).
- `use_fargate_spot`, `container_insights`, `alb_idle_timeout`,
  `alb_ingress_cidrs`.

## Outputs

`alb_dns_name` (point Cloudflare DNS here), `alb_zone_id`, `cluster_name`,
`service_name`, `log_group`.

## Deploying a new image

CI builds + pushes the image, then rolls the service:

```bash
aws ecs update-service --cluster <cluster> --service <service> --force-new-deployment
```

(or bump `api_image` and `terraform apply`). The circuit breaker rolls back if
the new tasks fail health checks.
