# Plan-level contract of the scheduled-job worker (var.worker). Mock provider:
# no AWS call, no credentials. Run:
#   terraform -chdir=infra/terraform/modules/ecs-api init -backend=false
#   terraform -chdir=infra/terraform/modules/ecs-api test

mock_provider "aws" {
  override_during = plan

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-0000000000000mock" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = {
      id   = "arn:aws:ecs:us-east-2:123456789012:cluster/kortix-test"
      name = "kortix-test"
    }
  }
}

variables {
  name               = "kortix-test"
  aws_region         = "us-east-2"
  vpc_id             = "vpc-0000000000000mock"
  public_subnet_ids  = ["subnet-public-a", "subnet-public-b"]
  private_subnet_ids = ["subnet-private-a", "subnet-private-b"]
  image              = "kortix/kortix-api:test"
  container_port     = 8008
  certificate_arn    = "arn:aws:acm:us-east-2:123456789012:certificate/test"
  secrets_blob_arn   = "arn:aws:secretsmanager:us-east-2:123456789012:secret:kortix-test-env-AbCdEf"
  environment = {
    KEEP                   = "from-terraform"
    KORTIX_PROCESS_ROLE    = "web"
    KORTIX_WORKER_ENV_FROM = "arn:aws:ecs:us-east-2:123456789012:task-definition/kortix-test:1"
  }
  # The worker must stay on-demand and egress-only whatever the API uses.
  use_fargate_spot         = true
  extra_security_group_ids = ["sg-extra-internal"]
  service_discovery        = { namespace_id = "ns-test" }
  tags                     = { Environment = "test", Service = "kortix-api" }
}

run "no_worker_by_default" {
  command = plan

  assert {
    condition     = length(aws_ecs_service.worker) == 0 && length(aws_ecs_task_definition.worker) == 0
    error_message = "var.worker = null must create no worker service and no worker task definition."
  }
  assert {
    condition = (
      length(aws_cloudwatch_log_metric_filter.worker_stale_jobs) == 0
      && length(aws_cloudwatch_metric_alarm.worker_not_running) == 0
      && length(aws_cloudwatch_metric_alarm.worker_stale_jobs) == 0
    )
    error_message = "var.worker = null must create no worker metric filter and no worker alarm."
  }
  assert {
    condition     = output.worker_service_name == null
    error_message = "worker_service_name must be null without a worker."
  }
}

run "worker_with_alarms" {
  command = plan

  variables {
    worker = {
      task_cpu           = 2048
      task_memory        = 4096
      metric_environment = "prod"
      alarm_topic_arn    = "arn:aws:sns:eu-west-2:123456789012:kortix-compliance-alerts"
    }
  }

  # ── service ──
  assert {
    condition     = aws_ecs_service.worker[0].name == "kortix-test-worker" && output.worker_service_name == "kortix-test-worker"
    error_message = "The worker service is <name>-worker and the output names it."
  }
  assert {
    condition     = aws_ecs_service.worker[0].desired_count == 0
    error_message = "Terraform creates the worker at desired_count 0; ecs-deploy.sh raises it after the migrations."
  }
  assert {
    condition = (
      length(aws_ecs_service.worker[0].capacity_provider_strategy) == 1
      && one(aws_ecs_service.worker[0].capacity_provider_strategy).capacity_provider == "FARGATE"
      && one(aws_ecs_service.worker[0].capacity_provider_strategy).base == 1
      && one(aws_ecs_service.worker[0].capacity_provider_strategy).weight == 1
    )
    error_message = "The worker runs on on-demand FARGATE (base 1, weight 1) even when use_fargate_spot = true."
  }
  assert {
    condition     = length(aws_ecs_service.worker[0].load_balancer) == 0 && length(aws_ecs_service.worker[0].service_registries) == 0
    error_message = "The worker takes no traffic: no load balancer, no Cloud Map record."
  }
  assert {
    condition     = aws_ecs_service.worker[0].network_configuration[0].security_groups == toset(["sg-0000000000000mock"])
    error_message = "The worker uses only the module's service security group, never the extra (ingress) groups."
  }
  assert {
    condition     = aws_ecs_service.worker[0].network_configuration[0].subnets == toset(["subnet-private-a", "subnet-private-b"])
    error_message = "The worker runs in the private subnets."
  }
  assert {
    condition = (
      aws_ecs_service.worker[0].deployment_minimum_healthy_percent == 100
      && aws_ecs_service.worker[0].deployment_maximum_percent == 200
      && aws_ecs_service.worker[0].deployment_circuit_breaker[0].enable
      && aws_ecs_service.worker[0].deployment_circuit_breaker[0].rollback
    )
    error_message = "The worker starts the new task before it stops the old one, with the circuit breaker on."
  }
  assert {
    condition     = aws_ecs_service.worker[0].cluster == aws_ecs_cluster.this.id
    error_message = "The worker lives in the API's cluster."
  }

  # ── task definition ──
  assert {
    condition = (
      aws_ecs_task_definition.worker[0].family == "kortix-test-worker"
      && aws_ecs_task_definition.worker[0].cpu == "2048"
      && aws_ecs_task_definition.worker[0].memory == "4096"
    )
    error_message = "The worker family is <name>-worker, sized by var.worker."
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].name == "worker"
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].image == "kortix/kortix-api:test"
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].command == ["bun", "run", "src/worker.ts"]
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].stopTimeout == 120
    )
    error_message = "Container `worker`, the API image, the default command, the API's stop timeout."
  }
  assert {
    condition = (
      !contains([for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : e.name], "KORTIX_PROCESS_ROLE")
      && contains([for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "PORT=8008")
      && contains([for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : "${e.name}=${e.value}"], "KEEP=from-terraform")
    )
    error_message = "The worker environment is the module environment plus PORT, without KORTIX_PROCESS_ROLE."
  }
  assert {
    condition     = !contains([for e in jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].environment : e.name], "KORTIX_WORKER_ENV_FROM")
    error_message = "Terraform's first worker revision never carries KORTIX_WORKER_ENV_FROM: only ecs-deploy.sh --service worker sets it, and the API goes `web` only on such a revision."
  }
  assert {
    condition = jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].secrets == [
      { name = "KORTIX_ENV_JSON", valueFrom = "arn:aws:secretsmanager:us-east-2:123456789012:secret:kortix-test-env-AbCdEf" }
    ]
    error_message = "The worker reads the same secrets blob as the API."
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].logConfiguration.options["awslogs-stream-prefix"] == "worker"
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].logConfiguration.options["awslogs-group"] == "/ecs/kortix-test"
    )
    error_message = "The worker logs to the API log group under stream prefix `worker`."
  }
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].healthCheck.command[1] == "bun"
      && strcontains(jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].healthCheck.command[3], "/health/ready")
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].healthCheck.interval == 30
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].healthCheck.timeout == 5
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].healthCheck.retries == 3
      && jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].healthCheck.startPeriod == 120
    )
    error_message = "The worker's container health check calls /health/ready through bun (30 s / 5 s / 3 / 120 s)."
  }

  # ── metric + alarms ──
  assert {
    condition = (
      aws_cloudwatch_log_metric_filter.worker_stale_jobs[0].log_group_name == "/ecs/kortix-test"
      && aws_cloudwatch_log_metric_filter.worker_stale_jobs[0].pattern == "{ $.kortix_metric = \"worker_jobs\" }"
      && aws_cloudwatch_log_metric_filter.worker_stale_jobs[0].metric_transformation[0].namespace == "Kortix/Worker"
      && aws_cloudwatch_log_metric_filter.worker_stale_jobs[0].metric_transformation[0].name == "StaleJobs"
      && aws_cloudwatch_log_metric_filter.worker_stale_jobs[0].metric_transformation[0].value == "$.stale_jobs"
      && aws_cloudwatch_log_metric_filter.worker_stale_jobs[0].metric_transformation[0].unit == "Count"
      && aws_cloudwatch_log_metric_filter.worker_stale_jobs[0].metric_transformation[0].dimensions == tomap({ Environment = "$.environment" })
    )
    error_message = "The StaleJobs metric filter reads the worker_jobs JSON line of the API log group."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_not_running[0].alarm_name == "kortix-test-worker-not-running"
      && aws_cloudwatch_metric_alarm.worker_not_running[0].namespace == "ECS/ContainerInsights"
      && aws_cloudwatch_metric_alarm.worker_not_running[0].metric_name == "RunningTaskCount"
      && aws_cloudwatch_metric_alarm.worker_not_running[0].dimensions == tomap({ ClusterName = "kortix-test", ServiceName = "kortix-test-worker" })
      && aws_cloudwatch_metric_alarm.worker_not_running[0].comparison_operator == "LessThanThreshold"
      && aws_cloudwatch_metric_alarm.worker_not_running[0].threshold == 1
      && aws_cloudwatch_metric_alarm.worker_not_running[0].period == 60
      && aws_cloudwatch_metric_alarm.worker_not_running[0].evaluation_periods == 5
      && aws_cloudwatch_metric_alarm.worker_not_running[0].datapoints_to_alarm == 5
      && aws_cloudwatch_metric_alarm.worker_not_running[0].treat_missing_data == "notBreaching"
    )
    error_message = "RunningTaskCount < 1 for 5 of 5 one-minute periods, missing data not breaching."
  }
  assert {
    condition = (
      aws_cloudwatch_metric_alarm.worker_stale_jobs[0].alarm_name == "kortix-test-worker-stale-jobs"
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].namespace == "Kortix/Worker"
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].metric_name == "StaleJobs"
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].dimensions == tomap({ Environment = "prod" })
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].statistic == "Maximum"
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].comparison_operator == "GreaterThanOrEqualToThreshold"
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].threshold == 1
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].period == 60
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].evaluation_periods == 5
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].datapoints_to_alarm == 5
      && aws_cloudwatch_metric_alarm.worker_stale_jobs[0].treat_missing_data == "notBreaching"
    )
    error_message = "StaleJobs (Maximum) >= 1 for 5 of 5 one-minute periods on the environment's dimension."
  }
  assert {
    condition = alltrue([
      for alarm in [aws_cloudwatch_metric_alarm.worker_not_running[0], aws_cloudwatch_metric_alarm.worker_stale_jobs[0]] :
      alarm.alarm_actions == toset(["arn:aws:sns:eu-west-2:123456789012:kortix-compliance-alerts"])
      && alarm.ok_actions == toset(["arn:aws:sns:eu-west-2:123456789012:kortix-compliance-alerts"])
    ])
    error_message = "Both alarms notify the topic on ALARM and on OK."
  }

  # ── the API service does not move ──
  assert {
    condition = (
      length(aws_ecs_service.this.load_balancer) == 1
      && length(aws_ecs_service.this.service_registries) == 1
      && aws_ecs_service.this.network_configuration[0].security_groups == toset(["sg-0000000000000mock", "sg-extra-internal"])
      && one(aws_ecs_service.this.capacity_provider_strategy).capacity_provider == "FARGATE_SPOT"
    )
    error_message = "Adding the worker must not change the API service."
  }
}

run "worker_without_alarms_keeps_the_metric" {
  command = plan

  variables {
    worker = {
      task_cpu    = 1024
      task_memory = 4096
      command     = ["bun", "run", "src/other-entry.ts"]
    }
  }

  assert {
    condition     = length(aws_cloudwatch_log_metric_filter.worker_stale_jobs) == 1
    error_message = "The StaleJobs metric filter exists without an alarm topic (dashboards read it)."
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.worker_not_running) == 0 && length(aws_cloudwatch_metric_alarm.worker_stale_jobs) == 0
    error_message = "No alarm without alarm_topic_arn."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.worker[0].container_definitions)[0].command == ["bun", "run", "src/other-entry.ts"]
    error_message = "worker.command overrides the default entrypoint."
  }
}

run "alarm_topic_requires_the_metric_environment" {
  command = plan

  variables {
    worker = {
      task_cpu        = 1024
      task_memory     = 4096
      alarm_topic_arn = "arn:aws:sns:us-east-2:123456789012:kortix-compliance-alerts"
    }
  }

  expect_failures = [var.worker]
}
