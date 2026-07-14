# The deployer is an in-account ECS task that mirrors signed images, registers
# task-def revisions, runs the migrate task, and rolls the three services. It is
# invoked by `kortix self-host deploy` (operator) and by the daily EventBridge
# Scheduler rule below (which no-ops when digests already match the manifest).

locals {
  ecs_arn_prefix   = "arn:${local.partition}:ecs:${local.region}:${var.expected_account_id}"
  service_arns     = [for f in [local.api_family, local.gateway_family, local.frontend_family] : "${local.ecs_arn_prefix}:service/${local.cluster_name}/${f}"]
  runnable_td_arns = [for f in [local.migrate_family, local.deployer_family] : "${local.ecs_arn_prefix}:task-definition/${f}:*"]
  passable_role_arns = [
    aws_iam_role.ecs_execution.arn,
    aws_iam_role.api_task.arn,
    aws_iam_role.gateway_task.arn,
    aws_iam_role.frontend_task.arn,
    aws_iam_role.migrate_task.arn,
    aws_iam_role.deployer_task.arn,
  ]
}

resource "aws_iam_role" "deployer_task" {
  name                 = "${var.name}-deployer-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

data "aws_iam_policy_document" "deployer_task" {
  #checkov:skip=CKV_AWS_356:ECS register/describe/list APIs and ECR/EC2 auth do not support resource-level ARNs; all mutating statements below are scoped to this installation's services, task-defs, repositories, host, and SSM parameter.

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "MirrorReleaseArtifacts"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for repository in aws_ecr_repository.enterprise : repository.arn]
  }

  statement {
    sid = "RegisterAndReadTaskDefs"
    actions = [
      "ecs:DeregisterTaskDefinition",
      "ecs:DescribeClusters",
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTaskDefinitions",
      "ecs:ListTasks",
      "ecs:RegisterTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "RollServices"
    actions   = ["ecs:UpdateService"]
    resources = local.service_arns
  }

  statement {
    sid       = "RunMigrateAndDeployerTasks"
    actions   = ["ecs:RunTask", "ecs:StopTask"]
    resources = local.runnable_td_arns
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = local.passable_role_arns
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "StageReleaseArtifacts"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/updater-staging/*"]
  }

  statement {
    sid     = "InstallSupabaseBundle"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.supabase.arn,
      "arn:${local.partition}:ssm:${local.region}::document/AWS-RunShellScript",
    ]
  }

  statement {
    sid = "ObserveSupabaseCommand"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ReadWriteReleaseBreadcrumb"
    actions = [
      "ssm:GetParameter",
      "ssm:PutParameter",
    ]
    resources = ["arn:${local.partition}:ssm:${local.region}:${var.expected_account_id}:parameter${local.release_ssm_param}"]
  }

  statement {
    sid       = "ReadRuntimeSecrets"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn, aws_secretsmanager_secret.updater.arn]
  }

  statement {
    sid       = "UseCustomerKeys"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn, aws_kms_key.secrets.arn]
  }

  statement {
    sid       = "InspectLoadBalancerHealth"
    actions   = ["elasticloadbalancing:DescribeTargetHealth", "elasticloadbalancing:DescribeTargetGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deployer_task" {
  name   = "${var.name}-deployer-task"
  role   = aws_iam_role.deployer_task.id
  policy = data.aws_iam_policy_document.deployer_task.json
}

# Human-readable breadcrumb of the currently reconciled release (replaces the
# DynamoDB release-state table; never a lock). The deployer owns the value.
resource "aws_ssm_parameter" "release" {
  #checkov:skip=CKV_AWS_337:The breadcrumb holds only public release metadata (version + image digests already visible via DescribeServices); the AWS-managed aws/ssm key avoids KeyId drift between Terraform and the deployer's overwrite calls.
  name        = local.release_ssm_param
  description = "Currently reconciled Kortix stable release for ${var.name}. Written by the deployer; never a lock."
  type        = "SecureString"
  value       = "unset"
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }

  tags = local.tags
}

# ── Daily auto-update check via EventBridge Scheduler ─────────────────────────
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.expected_account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${var.name}-deployer-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.scheduler_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "RunDeployerTask"
    actions   = ["ecs:RunTask"]
    resources = ["${local.ecs_arn_prefix}:task-definition/${local.deployer_family}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }

  statement {
    sid       = "PassDeployerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ecs_execution.arn, aws_iam_role.deployer_task.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${var.name}-deployer-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "deployer" {
  #checkov:skip=CKV_AWS_297:The schedule payload is a non-sensitive RunTask target; AWS-managed encryption suffices.
  count = var.enable_scheduled_deploy ? 1 : 0

  name        = "${var.name}-deployer"
  description = "Daily signed auto-update check; no-ops when running digests already match the stable manifest"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.scheduler_schedule_expression
  schedule_expression_timezone = "UTC"

  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      # Bare family so RunTask resolves the latest ACTIVE revision the deploy
      # tooling has registered (not the placeholder revision Terraform seeds).
      task_definition_arn = local.deployer_family
      task_count          = 1
      launch_type         = "FARGATE"

      network_configuration {
        subnets          = module.network.private_subnet_ids
        security_groups  = [aws_security_group.tasks.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts = 0
    }
  }

  depends_on = [aws_ecs_task_definition.deployer]
}
