# ecs-api — autoscaling Kortix API on ECS Fargate + ALB

The SOC2 target for the Kortix API: the `kortix/kortix-api` Docker image (the
same one `deploy-dev.yml` / `release.yml` build) running as an **ECS Fargate**
service behind an **Application Load Balancer**, with **target-tracking
autoscaling** on CPU. No EC2/Lightsail OS to patch — the strongest control
story for CC-series controls (least surface, managed runtime, immutable
deploys, CloudWatch logs + alarms).

## Why this replaces the Lightsail box (eventually)

Today dev/prod run as Docker on a single hand-managed Lightsail instance
behind nginx (blue/green 8008/8009), deployed over SSH. That has no horizontal
autoscaling, an OS to patch, and config that lives only on the box. This module
is the migration target: ≥2 tasks across AZs, rolling deploys, autoscaling,
and everything in code.

## ⚠️ This module provisions BILLABLE, net-new production infra

Applying it creates an ALB, a NAT-less Fargate service (tasks in public subnets
with assign_public_ip, or private subnets + NAT — see `assign_public_ip`),
CloudWatch log group, target group, autoscaling target + policy, and security
groups. **It is intentionally NOT wired into any environment yet** — adopt it
deliberately (new `environments/prod-ecs/`) after reviewing `terraform plan`
and the cost. Secrets are injected from SSM Parameter Store / Secrets Manager
ARNs you pass in — never hardcoded.

## Inputs of note

- `image` — full image ref, e.g. `kortix/kortix-api:0.8.31`.
- `desired_count`, `min_capacity`, `max_capacity`, `cpu_target_percent`.
- `container_secrets` — map of ENV_NAME → SSM/Secrets-Manager ARN.
- `vpc_id` / `subnet_ids` / `alb_subnet_ids` — bring your own network.
- `certificate_arn` — ACM cert for HTTPS on the ALB.
- `health_check_path` — defaults to `/v1/health`.
