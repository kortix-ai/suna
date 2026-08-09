terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 4.0, < 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : "0000000000000000000000000000000000000000"
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_vpc" "dev" {
  filter {
    name   = "tag:Name"
    values = ["kortix-dev-vpc"]
  }
}

data "aws_subnets" "dev_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.dev.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["public"]
  }
}

data "aws_subnets" "dev_private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.dev.id]
  }
  filter {
    name   = "tag:Tier"
    values = ["private"]
  }
}

data "aws_secretsmanager_secret" "preview" {
  name = "kortix-preview-env"
}

data "aws_secretsmanager_secret" "web" {
  name = "kortix-dev-web-env"
}

locals {
  name = "kortix-preview"
  tags = {
    Environment = "preview"
    ManagedBy   = "terraform"
    Project     = "kortix"
    Service     = "pr-preview-runtime"
  }
}

resource "aws_ecs_cluster" "preview" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "preview" {
  cluster_name       = aws_ecs_cluster.preview.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
}

data "aws_iam_policy_document" "task_assume" {
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
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_logs_kms" {
  #checkov:skip=CKV_AWS_109:The execution role receives only cryptographic data-plane actions on this one preview log key.
  #checkov:skip=CKV_AWS_111:The execution role cannot change the key or its policy.
  #checkov:skip=CKV_AWS_356:The policy is restricted to the preview log key ARN.
  name = "preview-logs-kms"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
      Resource = aws_kms_key.logs.arn
    }]
  })
}

resource "aws_iam_role_policy" "execution_secret" {
  name = "preview-secret-read"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      Resource = [
        data.aws_secretsmanager_secret.preview.arn,
        data.aws_secretsmanager_secret.web.arn,
      ]
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "logs_kms" {
  #checkov:skip=CKV_AWS_109:Account root administers this key; Logs gets only cryptographic actions with an encryption-context condition.
  #checkov:skip=CKV_AWS_111:Account root must administer the key; the service statement cannot change IAM or resource policies.
  #checkov:skip=CKV_AWS_356:The key ARN is unavailable while its key policy is evaluated; principals and encryption context constrain both statements.
  statement {
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values = [
        "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${local.name}",
        "arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:aws-waf-logs-${local.name}",
      ]
    }
  }
}

resource "aws_kms_key" "logs" {
  description             = "CloudWatch Logs encryption for ECS PR previews"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.logs_kms.json
  tags                    = local.tags
}

resource "aws_cloudwatch_log_group" "preview" {
  name              = "/ecs/${local.name}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${local.name}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.tags
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${local.name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS ingress to isolated PR previews"
  vpc_id      = data.aws_vpc.dev.id

  ingress {
    description = "Public preview HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = merge(local.tags, { Name = "${local.name}-alb" })
}

#trivy:ignore:AVD-AWS-0104 Preview tasks call external HTTPS APIs through the existing dev NAT gateway; those services have no stable CIDR allowlist.
resource "aws_security_group" "service" {
  #checkov:skip=CKV2_AWS_5:Per-PR ECS services attach this shared security group out-of-band in ecs-preview.sh.
  name        = "${local.name}-service"
  description = "Ingress from the preview ALB only"
  vpc_id      = data.aws_vpc.dev.id

  ingress {
    description     = "ALB to API"
    from_port       = 8008
    to_port         = 8008
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  ingress {
    description     = "ALB to frontend"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    description = "External HTTPS APIs"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "DNS over UDP"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = [data.aws_vpc.dev.cidr_block]
  }
  egress {
    description = "DNS over TCP"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.dev.cidr_block]
  }
  egress {
    description = "PostgreSQL data plane"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.postgres_egress_cidrs
  }
  tags = merge(local.tags, { Name = "${local.name}-service" })
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.service.id
  ip_protocol                  = "tcp"
  from_port                    = 8008
  to_port                      = 8008
  description                  = "ALB to preview API tasks only"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.service.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "ALB to preview frontend tasks only"
}

#trivy:ignore:AVD-AWS-0089 This is the terminal ALB access-log bucket; logging it recursively is invalid.
resource "aws_s3_bucket" "alb_logs" {
  #checkov:skip=CKV_AWS_18:This terminal ALB log bucket cannot log to itself.
  #checkov:skip=CKV_AWS_144:Ephemeral non-production access logs do not require cross-region replication.
  #checkov:skip=CKV_AWS_145:ALB log delivery supports SSE-S3, not customer-managed KMS keys.
  #checkov:skip=CKV2_AWS_62:ALB logs are retained for audit and do not require event notifications.
  bucket_prefix = "kortix-preview-alb-logs-"
  force_destroy = false
  tags          = local.tags
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
  rule { object_ownership = "BucketOwnerEnforced" }
}

#trivy:ignore:AVD-AWS-0132 ALB access-log delivery supports SSE-S3, not customer-managed KMS keys.
resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "retention"
    status = "Enabled"
    filter {}
    expiration { days = 365 }
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "alb_logs" {
  statement {
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
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/preview/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]
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

#trivy:ignore:AVD-AWS-0053 This direct HTTPS preview edge is protected by the regional WAF. Cloudflare cannot proxy the multi-level wildcard with Universal SSL.
resource "aws_lb" "preview" {
  #checkov:skip=CKV2_AWS_76:The dedicated aws_wafv2_web_acl.preview includes AWSManagedRulesKnownBadInputsRuleSet and is attached below; this graph check does not follow the separate association resource.
  name                       = "${local.name}-alb"
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = sort(data.aws_subnets.dev_public.ids)
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  idle_timeout               = 300

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "preview"
    enabled = true
  }
  tags       = local.tags
  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.preview.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.preview_certificate_arn

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "application/json"
      message_body = jsonencode({ error = "preview not found" })
      status_code  = "404"
    }
  }
}

module "acm_frontend" {
  source      = "../../modules/acm-cloudflare"
  domain_name = "*.preview.kortix.com"
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

resource "aws_lb_listener_certificate" "frontend" {
  listener_arn    = aws_lb_listener.https.arn
  certificate_arn = module.acm_frontend.certificate_arn
}

# A dedicated ACL keeps preview protections reviewable in this root instead of
# relying on an opaque account-wide ACL that static checks cannot inspect.
resource "aws_wafv2_web_acl" "preview" {
  name  = "${local.name}-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "preview-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit"
    priority = 20
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 2000
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "preview-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "preview-waf"
    sampled_requests_enabled   = true
  }
  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "preview" {
  resource_arn = aws_lb.preview.arn
  web_acl_arn  = aws_wafv2_web_acl.preview.arn
}

resource "aws_wafv2_web_acl_logging_configuration" "preview" {
  resource_arn            = aws_wafv2_web_acl.preview.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
}

resource "cloudflare_record" "preview_wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = "*.preview-api"
  type    = "CNAME"
  content = aws_lb.preview.dns_name
  proxied = false
  ttl     = 60
}

resource "cloudflare_record" "preview_frontend_wildcard" {
  zone_id = var.cloudflare_zone_id
  name    = "*.preview"
  type    = "CNAME"
  content = aws_lb.preview.dns_name
  proxied = false
  ttl     = 60
}

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_preview_deploy" {
  name = "kortix-gha-preview-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = [
            "repo:kortix-ai/suna:pull_request",
            "repo:kortix-ai/suna:ref:refs/heads/main",
          ]
        }
        StringLike = {
          "token.actions.githubusercontent.com:job_workflow_ref" = "kortix-ai/suna/.github/workflows/deploy-preview.yml@refs/heads/main"
        }
      }
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "github_preview_deploy" {
  #checkov:skip=CKV_AWS_355:ECS registration and describe/list APIs do not support resource-level permissions. Mutations are scoped to preview names, tags, cluster, listener, and roles.
  #checkov:skip=CKV_AWS_111:Write actions are restricted by preview resource names, request/resource tags, the one listener, and two preview roles.
  name = "preview-lifecycle"
  role = aws_iam_role.github_preview_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PreviewServiceLifecycle"
        Effect   = "Allow"
        Action   = ["ecs:DeleteService", "ecs:UpdateService", "ecs:DescribeServices"]
        Resource = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.name}/kortix-pr-*"
      },
      {
        Sid      = "CreatePreviewService"
        Effect   = "Allow"
        Action   = ["ecs:CreateService"]
        Resource = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.name}/kortix-pr-*"
        Condition = {
          StringEquals = { "aws:RequestTag/ManagedBy" = "deploy-preview-workflow" }
        }
      },
      {
        Sid      = "RegisterPreviewTaskDefinition"
        Effect   = "Allow"
        Action   = ["ecs:RegisterTaskDefinition", "ecs:TagResource"]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:RequestTag/ManagedBy" = "deploy-preview-workflow" }
        }
      },
      {
        Sid      = "DeletePreviewTaskDefinition"
        Effect   = "Allow"
        Action   = ["ecs:DeregisterTaskDefinition"]
        Resource = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/kortix-pr-*:*"
      },
      {
        Sid      = "PreviewRuntimeRead"
        Effect   = "Allow"
        Action   = ["ecs:DescribeClusters", "ecs:DescribeTasks", "ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions", "ecs:ListTasks", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "elasticloadbalancing:DescribeLoadBalancers", "elasticloadbalancing:DescribeListeners", "elasticloadbalancing:DescribeRules", "elasticloadbalancing:DescribeTargetGroups", "elasticloadbalancing:DescribeTargetHealth", "secretsmanager:DescribeSecret"]
        Resource = "*"
      },
      {
        Sid      = "CreatePreviewTargetGroup"
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:CreateTargetGroup", "elasticloadbalancing:AddTags"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestTag/Environment" = "preview"
            "aws:RequestTag/ManagedBy"   = "deploy-preview-workflow"
          }
        }
      },
      {
        Sid      = "DeletePreviewTargetGroup"
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:DeleteTargetGroup"]
        Resource = "arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:targetgroup/kortix-pr-*/*"
        Condition = {
          StringEquals = { "aws:ResourceTag/ManagedBy" = "deploy-preview-workflow" }
        }
      },
      {
        Sid    = "PreviewRuleLifecycle"
        Effect = "Allow"
        Action = ["elasticloadbalancing:CreateRule", "elasticloadbalancing:DeleteRule", "elasticloadbalancing:ModifyRule"]
        Resource = [
          aws_lb_listener.https.arn,
          "arn:${data.aws_partition.current.partition}:elasticloadbalancing:${var.aws_region}:${data.aws_caller_identity.current.account_id}:listener-rule/app/${local.name}-alb/*/*/*",
        ]
      },
      {
        Sid      = "PassPreviewRoles"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      }
    ]
  })
}
