# Reusable ECS Fargate service for the Kortix API, fronted by an ALB and
# horizontally autoscaled (target-tracking on CPU + memory). Identical module
# for dev and prod — only sizing/counts differ via variables, so prod is just
# "the same thing with bigger numbers and min_capacity >= 2".
#
# Inputs: a VPC + subnets (from modules/network), a container image, env/secrets,
# and an ACM cert. Outputs the ALB DNS name so the environment can point
# Cloudflare DNS at it.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  name = var.name
  # PORT is always injected so the app binds the port the target group checks.
  environment = merge(var.environment, { PORT = tostring(var.container_port) })
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

# ── Logs ──────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "logs_kms" {
  #checkov:skip=CKV_AWS_109:The account-root administration statement is the standard KMS key-policy control plane; CloudWatch Logs receives only encrypt/decrypt data-plane actions with an encryption-context condition.
  #checkov:skip=CKV_AWS_111:The account-root administration statement must manage this KMS key; the service statement has no IAM or resource-policy write actions.
  #checkov:skip=CKV_AWS_356:KMS key policies use Resource "*" because the key ARN does not exist until after policy evaluation; principals and the CloudWatch encryption context constrain access.
  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCloudWatchLogs"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.name}"]
    }
  }
}

resource "aws_kms_key" "logs" {
  description             = "CloudWatch Logs encryption for ${local.name}"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.logs_kms.json
  tags                    = var.tags
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${local.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
  tags              = var.tags
}

# ── IAM ───────────────────────────────────────────────────────────────────────
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags = {
    ManagedBy   = "terraform"
    Name        = "${local.name}-exec"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Let the execution role pull the values behind any injected secrets.
resource "aws_iam_role_policy" "secrets" {
  count = length(var.secrets) > 0 ? 1 : 0
  name  = "${local.name}-secrets-read"
  role  = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue", "ssm:GetParameters"]
      # Grant on the base secret/parameter ARN (strip any :json-key::version suffix from valueFrom).
      Resource = distinct([for v in values(var.secrets) : join(":", slice(split(":", v), 0, 7))])
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags = {
    ManagedBy   = "terraform"
    Name        = "${local.name}-task"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

# ── Security groups ───────────────────────────────────────────────────────────
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Ingress to the ${local.name} ALB"
  vpc_id      = var.vpc_id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }
  tags = {
    ManagedBy   = "terraform"
    Name        = "${local.name}-alb"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

#trivy:ignore:AVD-AWS-0104 ECS tasks call external HTTPS APIs and external PostgreSQL endpoints through NAT; these destinations do not have a stable CIDR allowlist.
resource "aws_security_group" "service" {
  name        = "${local.name}-svc"
  description = "Ingress to the ${local.name} tasks (from the ALB only)"
  vpc_id      = var.vpc_id

  ingress {
    description     = "From ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description = "HTTPS APIs and WSS providers"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "PostgreSQL data plane"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = {
    ManagedBy   = "terraform"
    Name        = "${local.name}-svc"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

# The ALB only needs to reach the application port on ECS tasks. Keeping this
# as a standalone rule avoids the dependency cycle that inline rules create
# when the service SG already references the ALB SG for ingress.
resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.service.id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port
  description                  = "ALB to ECS tasks only"
}

# ── Load balancer ─────────────────────────────────────────────────────────────
resource "aws_s3_bucket" "alb_logs" {
  #trivy:ignore:AVD-AWS-0089 This is the terminal ALB access-log bucket. Enabling server access logging on the terminal bucket creates recursive log delivery.
  #trivy:ignore:AVD-AWS-0132 Elastic Load Balancing access-log delivery supports SSE-S3. It does not support customer-managed KMS keys.
  #checkov:skip=CKV_AWS_18:This bucket is the terminal ALB access-log destination; logging it to another bucket creates a recursive log chain.
  #checkov:skip=CKV_AWS_144:ALB access logs are regional operational data with lifecycle retention; cross-region replication is not required.
  #checkov:skip=CKV_AWS_145:Elastic Load Balancing access logs support SSE-S3 and do not support customer-managed KMS keys.
  #checkov:skip=CKV2_AWS_62:ALB access logs are retained for audit and do not require an event-notification consumer.
  bucket_prefix = "${local.name}-alb-logs-"
  force_destroy = false
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "retention"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "alb_logs" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.alb_logs.arn, "${aws_s3_bucket.alb_logs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "AllowELBLogDelivery"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/${local.name}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = data.aws_iam_policy_document.alb_logs.json
}

#trivy:ignore:AVD-AWS-0053 This public API origin must accept Cloudflare traffic; the ALB security group restricts ingress to var.alb_ingress_cidrs.
resource "aws_lb" "this" {
  #checkov:skip=CKV2_AWS_28:The compliance-monitoring stack associates every account ALB with the regional kortix-alb-waf ACL.
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets = [
    var.public_subnet_ids[0],
    var.public_subnet_ids[1],
  ]
  idle_timeout               = var.alb_idle_timeout
  drop_invalid_header_fields = true
  enable_deletion_protection = true

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = local.name
    enabled = true
  }

  tags = {
    ManagedBy   = "terraform"
    Name        = "${local.name}-alb"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }

  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_lb_target_group" "this" {
  name        = "${local.name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = var.health_check_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200-399"
  }

  deregistration_delay = 30
  tags                 = var.tags
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

# ── ECS cluster + service ─────────────────────────────────────────────────────
resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }
  tags = {
    ManagedBy   = "terraform"
    Name        = local.name
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
    base              = var.use_fargate_spot ? 0 : 1
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = var.container_name
    image     = var.image
    essential = true
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    environment = [for k, v in local.environment : { name = k, value = v }]
    secrets     = [for k, v in var.secrets : { name = k, valueFrom = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = var.container_name
      }
    }
    # No container-level healthCheck: the Bun image has no curl/wget, and the
    # ALB target group health check (HTTP GET health_check_path) is the
    # authoritative gate for routing + the deployment circuit breaker.
  }])

  tags = {
    ManagedBy   = "terraform"
    Name        = local.name
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

resource "aws_ecs_service" "this" {
  name            = local.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = null # capacity-provider strategy drives placement

  capacity_provider_strategy {
    capacity_provider = var.use_fargate_spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
    base              = var.use_fargate_spot ? 0 : 1
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # Rolling deploy with circuit breaker → auto-rollback on a bad release.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # CI registers new task-def revisions out-of-band; autoscaling owns the count.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  # The selected listener must exist before the service so the target group is
  # associated with the load balancer before ECS validates CreateService.
  depends_on = [aws_lb_listener.https]
  tags = {
    ManagedBy   = "terraform"
    Name        = local.name
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

# ── Autoscaling (target tracking on CPU + memory) ─────────────────────────────
resource "aws_appautoscaling_target" "this" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${local.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

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
  name               = "${local.name}-mem"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = var.memory_target
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}

# Request-count scaling — scales on load even when CPU/memory stay flat (the
# failure mode of the 2026-06-08 incident, where the service was blocked on DB
# connections, not CPU). Opt-in: only created when requests_per_target_target > 0.
resource "aws_appautoscaling_policy" "requests" {
  count              = var.requests_per_target_target > 0 ? 1 : 0
  name               = "${local.name}-requests"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.this.arn_suffix}/${aws_lb_target_group.this.arn_suffix}"
    }
    target_value       = var.requests_per_target_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 30
  }
}
