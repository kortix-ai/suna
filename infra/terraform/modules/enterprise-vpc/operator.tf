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

  statement {
    sid = "InspectInstallation"
    actions = [
      "backup:Describe*",
      "backup:Get*",
      "backup:List*",
      "codebuild:BatchGetBuilds",
      "codebuild:ListBuildsForProject",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "ec2:Describe*",
      "ecr:Describe*",
      "ecr:ListImages",
      "eks:DescribeCluster",
      "eks:List*",
      "logs:Describe*",
      "logs:FilterLogEvents",
      "logs:GetLogEvents",
      "logs:GetQueryResults",
      "logs:StartQuery",
      "secretsmanager:DescribeSecret",
      "ssm:Describe*",
      "ssm:GetCommandInvocation",
      "ssm:GetConnectionStatus",
      "ssm:List*",
      "states:DescribeExecution",
      "states:DescribeStateMachine",
      "states:GetExecutionHistory",
      "states:ListExecutions",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ForceOrNormalReconcile"
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.reconcile.arn]
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

resource "aws_eks_access_entry" "operator" {
  count         = length(var.operator_principal_arns) > 0 ? 1 : 0
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.operator[0].arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "operator" {
  count         = length(var.operator_principal_arns) > 0 ? 1 : 0
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.operator[0].arn
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.operator]
}
