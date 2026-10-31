# ecs-api — autoscaling Kortix API on ECS Fargate + ALB

The `kortix-api` container running as an **ECS Fargate** service behind an
**Application Load Balancer**, horizontally **autoscaled** (target-tracking on
CPU **and** memory). One module, used by `environments/dev-us-east-2`,
`environments/staging-eu-west-2` and `environments/prod` — only the variables differ, so promoting to prod is "the
same thing with bigger numbers and `min_capacity >= 2`".

## What it creates

- ECS cluster (Container Insights optional) + Fargate service, on `FARGATE` or
  `FARGATE_SPOT` (`use_fargate_spot`, dev only: staging and prod run on-demand, because a Spot reclaim kills in-flight requests and agent turns).
- ALB in public subnets; tasks in private subnets (SG locks tasks to ALB only).
- HTTPS-only listener backed by the required `certificate_arn`; no HTTP listener
  or redirect is exposed.
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
- `use_fargate_spot`, `alb_idle_timeout`, `alb_ingress_cidrs`.
- Container Insights is always on: CloudWatch Container Insights is a
  monitoring control (Checkov CKV_AWS_65), not a per-environment option.

## Outputs

`alb_dns_name` (point Cloudflare DNS here), `alb_arn`, `alb_zone_id`,
`cluster_name`, `service_name`, `log_group`, `task_definition_arn`,
`task_role_arn`, `worker_service_name` (null without `worker`).

## Scheduled-job worker (`worker`)

Set `worker` on the API caller to run every scheduled job in its own service
instead of on an API task. The gateway and web callers leave it `null`.

```hcl
worker = {
  task_cpu           = 2048
  task_memory        = 4096
  metric_environment = "prod"                         # StaleJobs dimension
  alarm_topic_arn    = data.aws_sns_topic.alerts.arn  # null = no alarms
  # command          = ["bun", "run", "src/worker.ts"] (default)
}
```

It creates, in the API's cluster:

| Resource | Name | Notes |
|---|---|---|
| Task definition | family `<name>-worker`, container `worker` | Same image, roles, secrets blob, log group (`awslogs-stream-prefix = "worker"`) and `stop_timeout` as the API. Environment = the module environment without `KORTIX_PROCESS_ROLE` and without `KORTIX_WORKER_ENV_FROM`. Container health check: `bun -e fetch(…/health/ready)` every 30 s, timeout 5 s, 3 retries, start period 120 s. `container_definitions` is ignored after create. |
| ECS service | `<name>-worker` | `desired_count = 0` at create. On-demand `FARGATE` (base 1, weight 1) whatever `use_fargate_spot` says. Private subnets, the module's service security group only. No load balancer, no Cloud Map record, no autoscaling. Rolling 100 % / 200 % with the circuit breaker. `task_definition` and `desired_count` are ignored after create. |
| Log metric filter | `<name>-worker-stale-jobs` | `Kortix/Worker` `StaleJobs` = `$.stale_jobs` of the `{"kortix_metric":"worker_jobs",…}` line, dimension `Environment` = `$.environment`. Created without an alarm topic too. |
| Alarm | `<name>-worker-not-running` | `ECS/ContainerInsights` `RunningTaskCount` (Maximum) < 1 for 5 of 5 one-minute periods. Only with `alarm_topic_arn`. |
| Alarm | `<name>-worker-stale-jobs` | `Kortix/Worker` `StaleJobs` (Maximum) >= 1 for 5 of 5 one-minute periods, `Environment = metric_environment`. Only with `alarm_topic_arn`. |

Both alarms treat missing data as not breaching and send ALARM and OK to
`alarm_topic_arn`.

**Lifecycle.** Terraform applies before the database migrations in every
deploy workflow, so it never starts a worker. `infra/scripts/ecs-deploy.sh
<env> <image> --service worker` registers the next revision with the API
service's live environment and `KORTIX_WORKER_ENV_FROM=<that API task
definition ARN>`, sets desired count 1 and waits until the old task stopped.
The API roll that follows sets `KORTIX_PROCESS_ROLE=web` only when the worker
is ACTIVE, its PRIMARY deployment is COMPLETED, that revision carries
`KORTIX_WORKER_ENV_FROM` and runs the same image, and a task of that revision
is RUNNING and HEALTHY. Terraform's first revision never carries the variable,
so a circuit-breaker rollback onto it keeps the API on `all`. Otherwise too the
API gets `all` (it runs the jobs itself), and after its rollout completes the
script scales the worker to 0.

**Runbook.** Worker logs: `aws logs tail /ecs/<name> --log-stream-name-prefix
worker/worker/ --since 30m`. Kill switch: `ecs-deploy.sh <env> <image>
--process-role all` redeploys the API with `all` and scales the worker to 0.
The next `--service worker` roll brings it back.

`tests/worker.tftest.hcl` pins this contract at plan time with a mock
provider: `terraform -chdir=infra/terraform/modules/ecs-api init
-backend=false && terraform -chdir=infra/terraform/modules/ecs-api test`.

## Deploying a new image

CI builds and pushes the image, then rolls each service with
`infra/scripts/ecs-deploy.sh <env> <image> [--service api|gateway|web|worker]`.
The script registers a revision from the running one plus the secrets blob and
waits for the rollout. Never `terraform apply` an image change: the service
ignores `task_definition`. The circuit breaker rolls back if the new tasks fail
their health checks.
