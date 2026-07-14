data "aws_iam_policy_document" "operator_assume" {
  count = length(var.operator_principal_arns) > 0 ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = var.operator_principal_arns
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.operator_external_id]
    }
  }
}
resource "aws_iam_role" "operator" {
  count                = length(var.operator_principal_arns) > 0 ? 1 : 0
  name                 = "${var.name}-operator"
  assume_role_policy   = data.aws_iam_policy_document.operator_assume[0].json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "operator" {
  count = length(var.operator_principal_arns) > 0 ? 1 : 0

  #checkov:skip=CKV_AWS_356:Read-only describe/list APIs for ECS, EC2, ECR, logs, and scheduler do not support resource-level scoping; no mutation is granted here.
  statement {
    sid = "InspectInstallation"
    actions = [
      "backup:Describe*",
      "backup:Get*",
      "backup:List*",
      "ec2:Describe*",
      "ecr:Describe*",
      "ecr:ListImages",
      "ecs:Describe*",
      "ecs:List*",
      "elasticloadbalancing:Describe*",
      "logs:Describe*",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:GetQueryResults",
      "logs:StartQuery",
      "scheduler:GetSchedule",
      "scheduler:ListSchedules",
      "secretsmanager:DescribeSecret",
      "ssm:Describe*",
      "ssm:GetCommandInvocation",
      "ssm:GetConnectionStatus",
      "ssm:GetParameter",
      "ssm:List*",
    ]
    resources = ["*"]
  }

  statement {
    sid = "SsmOnlyHostOperations"
    actions = [
      "ssm:ResumeSession",
      "ssm:SendCommand",
      "ssm:StartSession",
      "ssm:TerminateSession",
    ]
    resources = [
      aws_instance.supabase.arn,
      "arn:${local.partition}:ssm:${local.region}::document/AWS-RunShellScript",
      "arn:${local.partition}:ssm:${local.region}:${var.expected_account_id}:session/*",
    ]
  }
}

resource "aws_iam_role_policy" "operator" {
  count  = length(var.operator_principal_arns) > 0 ? 1 : 0
  name   = "${var.name}-operator"
  role   = aws_iam_role.operator[0].id
  policy = data.aws_iam_policy_document.operator[0].json
}
