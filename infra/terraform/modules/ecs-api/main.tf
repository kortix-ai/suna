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

  # Capacity-provider strategy for the service.
  #
  #   use_fargate_spot = false          -> one FARGATE block (weight 1, base 1).
  #   use_fargate_spot = true, base = 0 -> one FARGATE_SPOT block (weight 1,
  #                                        base 0). Identical to the pre-2026-08-19
  #                                        single-block form, so dev/prod do not
  #                                        move.
  #   use_fargate_spot = true, base > 0 -> `base` tasks pinned to on-demand
  #                                        FARGATE, every task above that on
  #                                        FARGATE_SPOT.
  #
  # ECS satisfies `base` first, then splits the remainder by `weight`. The
  # on-demand block therefore carries weight 0: it must hold exactly the base,
  # never absorb scale-out. A Spot-only service with base 0 has no floor — one
  # Spot reclaim empties it, and with deployment_minimum_healthy_percent = 100
  # ECS cannot place a replacement until Spot capacity returns.
  capacity_provider_strategy = var.use_fargate_spot ? concat(
    var.fargate_base_on_demand > 0 ? [{
      capacity_provider = "FARGATE"
      weight            = 0
      base              = var.fargate_base_on_demand
    }] : [],
    [{
      capacity_provider = "FARGATE_SPOT"
      weight            = 1
      base              = 0
    }]
    ) : [{
      capacity_provider = "FARGATE"
      weight            = 1
      base              = 1
  }]
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
#
# Prefer secrets_blob_arn. ECS injects the complete secret JSON through one
# stable task-definition selector. The application expands it into process.env
# at startup. Adding or removing an optional JSON key does not invalidate an
# existing task definition. Granting on the blob ARN covers every key without a
# second hand-maintained selector list.
#
# var.secrets remains only as the fallback for callers that have not been
# given a blob yet; it resolves to the same base ARNs.
resource "aws_iam_role_policy" "secrets" {
  count = var.secrets_blob_arn != "" || length(var.secrets) > 0 ? 1 : 0
  name  = "${local.name}-secrets-read"
  role  = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue", "ssm:GetParameters"]
      # Strip any :json-key::version suffix to reach the base secret ARN.
      Resource = var.secrets_blob_arn != "" ? [var.secrets_blob_arn] : distinct([
        for v in values(var.secrets) : join(":", slice(split(":", v), 0, 7))
      ])
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

resource "aws_iam_role_policy" "ses_send" {
  count = length(var.ses_send_identity_names) > 0 ? 1 : 0
  name  = "${local.name}-ses-send"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "SendEmail"
      Effect = "Allow"
      Action = ["ses:SendEmail"]
      # SESv2 SendEmail authorizes against BOTH the sending identity AND the
      # configuration set named in the request — omitting the config-set ARN
      # 403s the whole send (found live on dev 2026-08-10: assumed-role send
      # denied on configuration-set/kortix-transactional while the identity
      # resources were correctly granted).
      Resource = concat(
        [
          for identity in var.ses_send_identity_names :
          "arn:${data.aws_partition.current.partition}:ses:${var.ses_send_region}:${data.aws_caller_identity.current.account_id}:identity/${identity}"
        ],
        [
          for cs in var.ses_send_configuration_set_names :
          "arn:${data.aws_partition.current.partition}:ses:${var.ses_send_region}:${data.aws_caller_identity.current.account_id}:configuration-set/${cs}"
        ],
      )
    }]
  })
}

# The API publishes project snapshots (leader worker) and mints presigned GETs
# for sandboxes from this role's credentials. Objects: PutObject + GetObject
# (HeadObject is authorized by GetObject). Bucket: ListBucket ONLY so a missing
# key answers 404 instead of 403 — without it the producer reads "not yet
# published" as AccessDenied and never builds (dev, 2026-09-14). Conditional
# writes (If-None-Match: *) need no extra action. No Delete anywhere.
resource "aws_iam_role_policy" "project_snapshots" {
  # A plan-time boolean, not the ARN: the ARN comes from a bucket created in the
  # same apply, and count cannot depend on a value unknown until apply.
  count = var.project_snapshots_enabled ? 1 : 0
  name  = "${local.name}-project-snapshots"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "SnapshotObjects"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${var.project_snapshot_bucket_arn}/*"
        }, {
        Sid      = "SnapshotMissingKeyIs404"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.project_snapshot_bucket_arn
      }],
      var.project_snapshot_kms_key_arn != "" ? [{
        Sid      = "SnapshotObjectsKms"
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = var.project_snapshot_kms_key_arn
      }] : [],
    )
  })
}

# The API exports weekly audit_events partitions to the audit-archive bucket
# (modules/audit-archive-bucket) with Object Lock retention. Write, set
# retention, read, list. NO s3:DeleteObject*, s3:BypassGovernanceRetention,
# s3:PutObjectLegalHold, or any bucket-configuration action: the role cannot
# shorten or remove a lock.
resource "aws_iam_role_policy" "audit_archive" {
  # A plan-time boolean, not the ARN: the ARN comes from a bucket created in the
  # same apply, and count cannot depend on a value unknown until apply.
  count = var.audit_archive_enabled ? 1 : 0
  name  = "${local.name}-audit-archive"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AuditArchiveObjects"
      Effect = "Allow"
      Action = [
        "s3:PutObject",
        "s3:PutObjectRetention",
        "s3:GetObject",
        "s3:GetObjectVersion",
      ]
      Resource = "${var.audit_archive_bucket_arn}/*"
      }, {
      Sid      = "AuditArchiveBucket"
      Effect   = "Allow"
      Action   = ["s3:ListBucket", "s3:GetBucketObjectLockConfiguration"]
      Resource = var.audit_archive_bucket_arn
      }, {
      Sid      = "AuditArchiveKms"
      Effect   = "Allow"
      Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
      Resource = var.audit_archive_kms_key_arn
    }]
  })
}

# Kortix Capture (modules/capture-store). The API reads device objects
# (ingestion), writes and deletes policy.json, deletes items past retention,
# signs media GETs, consumes the manifest-event queue, and assumes the device
# role to issue per-device credentials (always with a session policy that
# narrows it to one device folder: apps/api/src/capture/credentials.ts).
resource "aws_iam_role_policy" "capture" {
  # A plan-time boolean, not the ARNs: they come from resources created in the
  # same apply, and count cannot depend on a value unknown until apply.
  count = var.capture_enabled ? 1 : 0
  name  = "${local.name}-capture"
  role  = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "CaptureObjects"
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${var.capture_bucket_arn}/*"
      }, {
      Sid      = "CaptureMissingKeyIs404"
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = var.capture_bucket_arn
      }, {
      Sid      = "CaptureManifestEvents"
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
      Resource = var.capture_queue_arn
      }, {
      Sid      = "CaptureIssueDeviceCredentials"
      Effect   = "Allow"
      Action   = ["sts:AssumeRole"]
      Resource = var.capture_device_role_arn
    }]
  })
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
  dynamic "egress" {
    for_each = var.enable_postgres_egress ? [1] : []
    content {
      description = "PostgreSQL data plane"
      from_port   = 5432
      to_port     = 5432
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    }
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
#trivy:ignore:AVD-AWS-0089 This is the terminal ALB access-log bucket. Enabling server access logging on the terminal bucket creates recursive log delivery.
resource "aws_s3_bucket" "alb_logs" {
  #checkov:skip=CKV_AWS_18:This bucket is the terminal ALB access-log destination; logging it to another bucket creates a recursive log chain.
  #checkov:skip=CKV_AWS_144:ALB access logs are regional operational data with lifecycle retention; cross-region replication is not required.
  #checkov:skip=CKV_AWS_145:Elastic Load Balancing access logs support SSE-S3 and do not support customer-managed KMS keys.
  #checkov:skip=CKV2_AWS_62:ALB access logs are retained for audit and do not require an event-notification consumer.
  bucket_prefix = "${local.name}-alb-logs-"
  force_destroy = false
  tags          = var.tags
}

resource "aws_s3_bucket_versioning" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  versioning_configuration {
    status = "Enabled"
  }
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

#trivy:ignore:AVD-AWS-0132 Elastic Load Balancing access-log delivery supports SSE-S3. It does not support customer-managed KMS keys.
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
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
  #checkov:skip=CKV2_AWS_28:Environment roots associate this output ALB with a regional WAF; legacy API roots use the compliance-monitoring association.
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

  deregistration_delay = var.deregistration_delay
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

# ── Private DNS for in-VPC callers (optional) ────────────────────────────────
# ECS registers each RUNNING task's private IP under <container_name>.<namespace>
# and removes it when the task stops. Callers resolve the name through the VPC
# resolver and connect to the task directly, without the ALB.
resource "aws_service_discovery_service" "this" {
  count = var.service_discovery == null ? 0 : 1
  name  = var.container_name

  dns_config {
    namespace_id   = var.service_discovery.namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  tags = var.tags
}

# ── ECS cluster + service ─────────────────────────────────────────────────────
resource "aws_ecs_cluster" "this" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
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
    # Give the app time to finish in-flight work after SIGTERM. Without this
    # ECS defaults to 30s, so a streaming response longer than that was killed
    # on every deploy, scale-in and Spot reclaim.
    stopTimeout = var.stop_timeout
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    environment = [for k, v in local.environment : { name = k, value = v }]
    secrets = var.secrets_blob_arn != "" ? [
      { name = "KORTIX_ENV_JSON", valueFrom = var.secrets_blob_arn }
    ] : [for k, v in var.secrets : { name = k, valueFrom = v }]
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

  # This resource only bootstraps the FIRST revision. Every later one is
  # registered by ecs-deploy.sh, which rebuilds the container definition from
  # the live service plus the secrets blob — so image, environment and secrets
  # here go stale the moment anything deploys. The service already ignores
  # task_definition, so re-registering from stale inputs on every apply
  # produced an orphan revision nothing ran and a permanent "must be replaced"
  # in the plan. Ceding the container definition removes the phantom diff and
  # makes the deploy script the single owner of revisions.
  lifecycle {
    ignore_changes = [container_definitions]
  }

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

  dynamic "capacity_provider_strategy" {
    for_each = local.capacity_provider_strategy
    content {
      capacity_provider = capacity_provider_strategy.value.capacity_provider
      weight            = capacity_provider_strategy.value.weight
      base              = capacity_provider_strategy.value.base
    }
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = concat([aws_security_group.service.id], var.extra_security_group_ids)
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = var.container_name
    container_port   = var.container_port
  }

  dynamic "service_registries" {
    for_each = aws_service_discovery_service.this
    content {
      registry_arn = service_registries.value.arn
    }
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # The AWS provider refuses to update `capacity_provider_strategy` unless
  # `force_new_deployment` is set ("force_new_deployment should be true when
  # capacity_provider_strategy is being updated"). A service whose strategy
  # changes sets `force_new_deployment` (staging left Spot on 2026-10-13); dev
  # and prod keep today's plan byte-for-byte. `task_definition` stays under
  # ignore_changes, so a forced deployment re-rolls the service's CURRENT task
  # definition — the one ecs-deploy.sh registered — never a stale TF revision.
  force_new_deployment = var.force_new_deployment || var.fargate_base_on_demand > 0

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

  lifecycle {
    precondition {
      condition     = var.fargate_base_on_demand <= var.min_capacity
      error_message = "fargate_base_on_demand (${var.fargate_base_on_demand}) exceeds min_capacity (${var.min_capacity}); the autoscaling floor cannot be smaller than the on-demand base."
    }
  }
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

# ── Scheduled-job worker (optional, var.worker) ──────────────────────────────
# Problem: one API task per environment won the Postgres leader lease and ran
# every scheduled job (~35) while it also served traffic. On prod that is
# ~0.73 of the task's 1 vCPU, which held the fleet's average CPU near the 55 %
# scale-out target, and every scale-in that picked that task killed the leader.
#
# The worker runs the same image with its own entrypoint (var.worker.command)
# in this cluster. It takes no traffic. ecs-deploy.sh deploys the API with
# KORTIX_PROCESS_ROLE=web only while this service runs the API's exact image
# and has a HEALTHY task; otherwise the API runs with `all` (jobs included) and
# the script scales this service to 0 after the API roll.
locals {
  worker_name = "${local.name}-worker"
  # KORTIX_PROCESS_ROLE is an API-only switch: the worker ignores it, and a
  # value copied here would only mislead a reader of the task definition.
  worker_environment = { for k, v in local.environment : k => v if k != "KORTIX_PROCESS_ROLE" }
  worker_alarms      = try(var.worker.alarm_topic_arn, null) != null
}

resource "aws_ecs_task_definition" "worker" {
  count                    = var.worker == null ? 0 : 1
  family                   = local.worker_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker.task_cpu
  memory                   = var.worker.task_memory
  # The API's roles: the worker runs the API's jobs, so it needs exactly the
  # API's grants (secrets blob, snapshots, audit archive, capture, SES).
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn      = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "worker"
    image     = var.image
    essential = true
    command   = var.worker.command
    # The worker hands back the leader lease and its job claims on SIGTERM
    # before it exits; the same budget as the API.
    stopTimeout = var.stop_timeout
    # No load balancer reads this port. The worker serves /health/ready and
    # /health/live on PORT for the container health check below.
    portMappings = [{
      containerPort = var.container_port
      protocol      = "tcp"
    }]
    environment = [for k, v in local.worker_environment : { name = k, value = v }]
    secrets = var.secrets_blob_arn != "" ? [
      { name = "KORTIX_ENV_JSON", valueFrom = var.secrets_blob_arn }
    ] : [for k, v in var.secrets : { name = k, valueFrom = v }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.this.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
    # No target group checks this task, so the container health check is the
    # deployment gate: ECS replaces the old worker only after the new one is
    # HEALTHY. The image has no curl/wget; bun is the HTTP client.
    # /health/ready answers 503 until boot finishes and while draining.
    healthCheck = {
      command     = ["CMD", "bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8008)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 120
    }
  }])

  # Same ownership as aws_ecs_task_definition.this: this resource registers the
  # first revision only. ecs-deploy.sh --service worker registers every later
  # one, with the API service's live environment.
  lifecycle {
    ignore_changes = [container_definitions]
  }

  tags = {
    ManagedBy   = "terraform"
    Name        = local.worker_name
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

resource "aws_ecs_service" "worker" {
  count           = var.worker == null ? 0 : 1
  name            = local.worker_name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker[0].arn
  # 0 at create, on purpose. Terraform applies BEFORE the database migrations
  # in every deploy workflow, and this first revision carries only Terraform's
  # environment. A task started here would run new job code on the old schema
  # without the deploy overrides. ecs-deploy.sh --service worker sets 1.
  desired_count = 0
  launch_type   = null

  # On-demand always, whatever use_fargate_spot says: a Spot reclaim stops the
  # only task that runs scheduled jobs.
  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }

  # Egress only (the service security group admits nothing but the ALB). The
  # extra security groups carry VPC-internal ingress rules for API traffic,
  # which the worker does not take.
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = var.assign_public_ip
  }

  # Start the new worker, wait until it is HEALTHY, then stop the old one. The
  # old worker hands the lease over on SIGTERM, so the overlap never runs a job
  # twice.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # ecs-deploy.sh owns the revision and the count (1 after a worker roll, 0
  # after an API roll that fell back to KORTIX_PROCESS_ROLE=all).
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_ecs_cluster_capacity_providers.this]

  tags = {
    ManagedBy   = "terraform"
    Name        = local.worker_name
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

# Kortix/Worker StaleJobs. The lease holder writes one JSON line to stdout
# every 60 s:
#   {"kortix_metric":"worker_jobs","environment":"prod","stale_jobs":0,"jobs_seen":35,"stale":[]}
# A filter on the whole log group, not on the worker streams only: while an API
# task holds the lease (KORTIX_PROCESS_ROLE=all), it writes the same line. The
# filter exists without alarm_topic_arn so the metric is there for dashboards.
resource "aws_cloudwatch_log_metric_filter" "worker_stale_jobs" {
  count          = var.worker == null ? 0 : 1
  name           = "${local.worker_name}-stale-jobs"
  log_group_name = aws_cloudwatch_log_group.this.name
  pattern        = "{ $.kortix_metric = \"worker_jobs\" }"

  metric_transformation {
    namespace  = "Kortix/Worker"
    name       = "StaleJobs"
    value      = "$.stale_jobs"
    unit       = "Count"
    dimensions = { Environment = "$.environment" }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_not_running" {
  count             = local.worker_alarms && var.worker != null ? 1 : 0
  alarm_name        = "${local.worker_name}-not-running"
  alarm_description = "No ${local.worker_name} task has run for 5 minutes, so no process runs scheduled jobs unless the API runs with KORTIX_PROCESS_ROLE=all. Expected after a deploy that printed 'Worker scaled to 0' (the API fell back to all); the next successful worker roll clears it. Otherwise read the service events and the log streams worker/worker/<task-id> in /ecs/${local.name}. Kill switch: redeploy the API with infra/scripts/ecs-deploy.sh <env> <image> --process-role all."
  namespace         = "ECS/ContainerInsights"
  metric_name       = "RunningTaskCount"
  dimensions = {
    ClusterName = aws_ecs_cluster.this.name
    ServiceName = aws_ecs_service.worker[0].name
  }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.worker.alarm_topic_arn]
  ok_actions          = [var.worker.alarm_topic_arn]

  tags = {
    ManagedBy   = "terraform"
    Name        = "${local.worker_name}-not-running"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_stale_jobs" {
  count             = local.worker_alarms && var.worker != null ? 1 : 0
  alarm_name        = "${local.worker_name}-stale-jobs"
  alarm_description = "At least one scheduled job on ${coalesce(try(var.worker.metric_environment, null), "unset")} has been overdue for 5 minutes in a row (Kortix/Worker StaleJobs, Maximum per minute, written by the lease holder every 60 s). The job names are in the `stale` field of the latest {\"kortix_metric\":\"worker_jobs\"} line: log streams worker/worker/<task-id> in /ecs/${local.name}, or api/api/<task-id> while the API runs the jobs. Kill switch: redeploy the API with infra/scripts/ecs-deploy.sh <env> <image> --process-role all, which runs the jobs on the API tasks and scales the worker to 0."
  namespace         = "Kortix/Worker"
  metric_name       = "StaleJobs"
  dimensions = {
    Environment = try(var.worker.metric_environment, null)
  }
  # Only the lease holder writes the line. Maximum keeps one stale report from
  # being averaged away by a period with several datapoints.
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.worker.alarm_topic_arn]
  ok_actions          = [var.worker.alarm_topic_arn]

  tags = {
    ManagedBy   = "terraform"
    Name        = "${local.worker_name}-stale-jobs"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", local.name)
  }
}
