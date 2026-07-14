# ECS Fargate control plane for the enterprise installation: one cluster, three
# long-running services (api/gateway/frontend) behind the shared ALB (alb.tf),
# and two one-off task definitions (migrate/deployer). Patterns are lifted from
# modules/ecs-api (the prod-proven module): circuit-breaker rollback, secrets
# injected from Secrets Manager, ignore_changes so the deployer owns revisions,
# and target-tracking autoscaling.

locals {
  api_port      = 8008
  gateway_port  = 8090
  frontend_port = 3000
  supabase_port = 8000

  runtime_secret_list = [for k, v in local.runtime_secrets : { name = k, valueFrom = v }]
}

# ── Cluster ───────────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "this" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  configuration {
    execute_command_configuration {
      logging = "DEFAULT"
    }
  }

  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# ── Log groups (KMS-encrypted; names match the kms.tf CloudWatchLogs grant) ────
resource "aws_cloudwatch_log_group" "ecs" {
  for_each          = toset(["api", "gateway", "frontend", "migrate", "deployer"])
  name              = "/kortix/${var.name}/ecs/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}

# ── Security group for all ECS tasks ──────────────────────────────────────────
resource "aws_security_group" "tasks" {
  name_prefix = "${var.name}-ecs-tasks-"
  description = "Kortix ECS Fargate tasks; ingress from the ALB only"
  vpc_id      = module.network.vpc_id

  # AWS APIs (Secrets Manager, ECR, KMS, Bedrock, logs), release + registry pulls
  # reach private endpoints and the NAT gateway on TLS.
  #trivy:ignore:AVD-AWS-0104
  egress {
    description = "TLS to AWS endpoints, ECR, and Bedrock"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Reach the Supabase host (Kong 8000, Postgres 5432) and VPC resolver"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = [var.vpc_cidr]
  }

  tags = merge(local.tags, { Name = "${var.name}-ecs-tasks" })
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  for_each                     = toset([tostring(local.api_port), tostring(local.gateway_port), tostring(local.frontend_port)])
  security_group_id            = aws_security_group.tasks.id
  referenced_security_group_id = aws_security_group.alb.id
  description                  = "Container port ${each.key} from the shared ALB"
  ip_protocol                  = "tcp"
  from_port                    = tonumber(each.key)
  to_port                      = tonumber(each.key)
  tags                         = local.tags
}

# ── IAM: one shared execution role, per-service task roles ────────────────────
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name                 = "${var.name}-ecs-exec"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role pulls KMS-encrypted images and reads every runtime-secret
# JSON key the deployer wires into task-defs, so it is granted the whole secret.
data "aws_iam_policy_document" "ecs_execution" {
  statement {
    sid       = "ReadRuntimeSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn, aws_secretsmanager_secret.updater.arn]
  }
  statement {
    sid       = "DecryptSecretsKey"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.secrets.arn]
  }
  statement {
    sid       = "DecryptImageAndLogKey"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.data.arn]
  }
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "${var.name}-ecs-exec"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution.json
}

# Task roles carry runtime AWS privileges. api/migrate mirror the old EKS app
# IRSA (read the runtime secret + secrets KMS); gateway additionally invokes
# Bedrock; frontend needs nothing.
data "aws_iam_policy_document" "app_task" {
  statement {
    sid       = "ReadRuntimeSecret"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }
  statement {
    sid       = "UseSecretsKey"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role" "api_task" {
  name                 = "${var.name}-api-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "api_task" {
  name   = "${var.name}-api-task"
  role   = aws_iam_role.api_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

resource "aws_iam_role" "migrate_task" {
  name                 = "${var.name}-migrate-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "migrate_task" {
  name   = "${var.name}-migrate-task"
  role   = aws_iam_role.migrate_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

resource "aws_iam_role" "gateway_task" {
  name                 = "${var.name}-gateway-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

# The gateway resolves managed Claude models to Bedrock with task-role
# credentials and no OpenRouter dependency (spec: certification-blocking gap).
data "aws_iam_policy_document" "gateway_task" {
  source_policy_documents = [data.aws_iam_policy_document.app_task.json]

  statement {
    sid = "InvokeBedrock"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = var.bedrock_model_allowlist
  }
}

resource "aws_iam_role_policy" "gateway_task" {
  name   = "${var.name}-gateway-task"
  role   = aws_iam_role.gateway_task.id
  policy = data.aws_iam_policy_document.gateway_task.json
}

resource "aws_iam_role" "frontend_task" {
  name                 = "${var.name}-frontend-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

# ── Task definitions ──────────────────────────────────────────────────────────
resource "aws_ecs_task_definition" "api" {
  family                   = local.api_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_task_cpu
  memory                   = var.api_task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn

  container_definitions = jsonencode([{
    name         = "api"
    image        = local.api_image
    essential    = true
    portMappings = [{ containerPort = local.api_port, protocol = "tcp" }]
    environment  = [{ name = "PORT", value = tostring(local.api_port) }, { name = "AWS_REGION", value = local.region }]
    secrets      = local.runtime_secret_list
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["api"].name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = local.gateway_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.gateway_task_cpu
  memory                   = var.gateway_task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn

  container_definitions = jsonencode([{
    name         = "gateway"
    image        = local.gateway_image
    essential    = true
    portMappings = [{ containerPort = local.gateway_port, protocol = "tcp" }]
    environment  = [{ name = "PORT", value = tostring(local.gateway_port) }, { name = "AWS_REGION", value = local.region }]
    secrets      = local.runtime_secret_list
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["gateway"].name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "gateway"
      }
    }
  }])

  tags = local.tags
}

resource "aws_ecs_task_definition" "frontend" {
  family                   = local.frontend_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.frontend_task_cpu
  memory                   = var.frontend_task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.frontend_task.arn

  container_definitions = jsonencode([{
    name         = "frontend"
    image        = local.frontend_image
    essential    = true
    portMappings = [{ containerPort = local.frontend_port, protocol = "tcp" }]
    environment  = [{ name = "PORT", value = tostring(local.frontend_port) }]
    secrets      = local.runtime_secret_list
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["frontend"].name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "frontend"
      }
    }
  }])

  tags = local.tags
}

# One-off: database bootstrap/migration, run by the deployer before rolling
# services. Command per spec.
resource "aws_ecs_task_definition" "migrate" {
  family                   = local.migrate_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.migrate_task_cpu
  memory                   = var.migrate_task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.migrate_task.arn

  container_definitions = jsonencode([{
    name        = "migrate"
    image       = local.api_image
    essential   = true
    command     = ["bun", "scripts/migrate.ts", "bootstrap"]
    environment = [{ name = "AWS_REGION", value = local.region }]
    secrets     = local.runtime_secret_list
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["migrate"].name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "migrate"
      }
    }
  }])

  tags = local.tags
}

# One-off: the slim signed deployer, invoked by the operator CLI and the daily
# EventBridge Scheduler rule. Its image + command are owned by the deploy tooling.
resource "aws_ecs_task_definition" "deployer" {
  family                   = local.deployer_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.deployer_task_cpu
  memory                   = var.deployer_task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.deployer_task.arn

  container_definitions = jsonencode([{
    name      = "deployer"
    image     = local.deployer_image
    essential = true
    command   = var.deployer_command
    environment = [
      { name = "AWS_REGION", value = local.region },
      { name = "KORTIX_INSTANCE", value = var.name },
      { name = "KORTIX_EXPECTED_ACCOUNT_ID", value = var.expected_account_id },
      { name = "KORTIX_CHANNEL", value = var.release_channel },
      { name = "KORTIX_RELEASE_REPOSITORY", value = var.release_repository_url },
      { name = "KORTIX_TUF_ROOT_SHA256", value = var.tuf_root_sha256 },
      { name = "KORTIX_MAINTENANCE_WINDOW", value = var.maintenance_window },
      { name = "KORTIX_CLUSTER", value = local.cluster_name },
      { name = "KORTIX_API_SERVICE", value = local.api_family },
      { name = "KORTIX_GATEWAY_SERVICE", value = local.gateway_family },
      { name = "KORTIX_FRONTEND_SERVICE", value = local.frontend_family },
      { name = "KORTIX_MIGRATE_TASKDEF", value = local.migrate_family },
      { name = "KORTIX_RELEASE_SSM_PARAM", value = local.release_ssm_param },
      { name = "KORTIX_RUNTIME_SECRET_ARN", value = aws_secretsmanager_secret.runtime.arn },
      { name = "KORTIX_UPDATER_SECRET_ARN", value = aws_secretsmanager_secret.updater.arn },
      { name = "KORTIX_SUPABASE_INSTANCE_ID", value = aws_instance.supabase.id },
      { name = "KORTIX_SUPABASE_PRIVATE_IP", value = aws_instance.supabase.private_ip },
      { name = "KORTIX_ECR_REPOSITORIES", value = jsonencode({ for name, repository in aws_ecr_repository.enterprise : name => repository.repository_url }) },
      # Public domains for health checks + the Supabase install (the ALB serves
      # the Supabase data-plane prefixes on the frontend/root host, the app on api).
      { name = "KORTIX_API_DOMAIN", value = var.api_domain },
      { name = "KORTIX_FRONTEND_DOMAIN", value = var.frontend_domain },
      # awsvpc network config for the one-off migrate RunTask (private subnets +
      # the shared task SG), passed verbatim to `ecs run-task --network-configuration`.
      { name = "KORTIX_TASK_NETWORK_CONFIGURATION", value = jsonencode({
        awsvpcConfiguration = {
          subnets        = module.network.private_subnet_ids
          securityGroups = [aws_security_group.tasks.id]
          assignPublicIp = "DISABLED"
        }
      }) },
      # KMS-encrypted staging bucket for the Supabase bundle tarball (storage.tf).
      { name = "KORTIX_ARTIFACT_BUCKET", value = aws_s3_bucket.artifacts.bucket },
      { name = "KORTIX_ARTIFACT_KMS_KEY_ARN", value = aws_kms_key.data.arn },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["deployer"].name
        "awslogs-region"        = local.region
        "awslogs-stream-prefix" = "deployer"
      }
    }
  }])

  tags = local.tags
}

# ── Services ──────────────────────────────────────────────────────────────────
resource "aws_ecs_service" "api" {
  name            = local.api_family
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_min_capacity

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.api_port
  }

  # AZ spread across the private subnets.
  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # The deployer registers new task-def revisions and rolls the service;
  # autoscaling owns the count.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

resource "aws_ecs_service" "gateway" {
  name            = local.gateway_family
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = var.gateway_min_capacity

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = local.gateway_port
  }

  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

resource "aws_ecs_service" "frontend" {
  name            = local.frontend_family
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = var.frontend_desired_count

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets          = module.network.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.frontend.arn
    container_name   = "frontend"
    container_port   = local.frontend_port
  }

  ordered_placement_strategy {
    type  = "spread"
    field = "attribute:ecs.availability-zone"
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

# ── Autoscaling (target tracking on CPU + memory) ─────────────────────────────
locals {
  autoscaled_services = {
    api = {
      resource_id  = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
      min_capacity = var.api_min_capacity
      max_capacity = var.api_max_capacity
    }
    gateway = {
      resource_id  = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.gateway.name}"
      min_capacity = var.gateway_min_capacity
      max_capacity = var.gateway_max_capacity
    }
    frontend = {
      resource_id  = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.frontend.name}"
      min_capacity = var.frontend_desired_count
      max_capacity = var.frontend_desired_count
    }
  }
}

resource "aws_appautoscaling_target" "svc" {
  for_each           = local.autoscaled_services
  max_capacity       = each.value.max_capacity
  min_capacity       = each.value.min_capacity
  resource_id        = each.value.resource_id
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = local.autoscaled_services
  name               = "${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.cpu_target
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}

resource "aws_appautoscaling_policy" "memory" {
  for_each           = local.autoscaled_services
  name               = "${each.key}-mem"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = var.memory_target
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}
