provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  tags = merge(var.tags, {
    ManagedBy = "terraform"
    System    = "kortix-enterprise-release"
  })
}

resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "publisher bootstrap AWS account mismatch"
    }
  }
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "terraform" {
  name                 = var.terraform_role_name
  description          = "Protected GitHub Terraform role for the Kortix enterprise release publisher"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
  tags                 = local.tags
}

resource "aws_iam_role_policy_attachment" "power_user" {
  role       = aws_iam_role.terraform.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/PowerUserAccess"
}

data "aws_iam_policy_document" "publisher_iam" {
  statement {
    sid     = "CreateOnlyBoundedPublisherRoles"
    actions = ["iam:CreateRole"]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/${var.publisher_name}-promotion",
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/${var.publisher_name}-timestamp-refresh",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [aws_iam_policy.publisher_runtime_boundary.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/System"
      values   = ["kortix-enterprise-release"]
    }
  }

  statement {
    sid = "ReadOnlyPublisherRoleState"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/${var.publisher_name}-promotion",
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/${var.publisher_name}-timestamp-refresh",
    ]
  }

  statement {
    sid = "ManageOnlyTaggedPublisherRoles"
    actions = [
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/${var.publisher_name}-promotion",
      "arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:role/${var.publisher_name}-timestamp-refresh",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:ResourceTag/System"
      values   = ["kortix-enterprise-release"]
    }
  }
}

resource "aws_iam_role_policy" "publisher_iam" {
  name   = "${var.publisher_name}-terraform-iam"
  role   = aws_iam_role.terraform.id
  policy = data.aws_iam_policy_document.publisher_iam.json
}

data "aws_iam_policy_document" "publisher_runtime_boundary" {
  statement {
    sid = "UseOnlyOnlinePublisherSigningKeys"
    actions = [
      "kms:GetPublicKey",
      "kms:Sign",
    ]
    resources = ["*"]

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "kms:ResourceAliases"
      values = [
        "alias/${var.publisher_name}-tuf-targets",
        "alias/${var.publisher_name}-tuf-snapshot",
        "alias/${var.publisher_name}-tuf-timestamp",
        "alias/${var.publisher_name}-cosign",
      ]
    }
  }

  statement {
    sid = "UseOnlyPublisherRepositoryEncryptionKey"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "kms:ResourceAliases"
      values   = ["alias/${var.publisher_name}-repository"]
    }
  }

  statement {
    sid = "UseOnlyPublisherRepositoryObjects"
    actions = [
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:PutObject",
      "s3:PutObjectRetention",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:s3:::${var.repository_bucket_name}",
      "arn:${data.aws_partition.current.partition}:s3:::${var.repository_bucket_name}/*",
    ]
  }

  statement {
    sid       = "InvalidateOnlyPublisherDistributions"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = ["arn:${data.aws_partition.current.partition}:cloudfront::${var.expected_account_id}:distribution/*"]
  }

  dynamic "statement" {
    for_each = length(var.customer_event_bus_arns) == 0 ? [] : [1]
    content {
      sid       = "SendOnlyConfiguredCustomerHints"
      actions   = ["events:PutEvents"]
      resources = var.customer_event_bus_arns
    }
  }
}

resource "aws_iam_policy" "publisher_runtime_boundary" {
  name        = "${var.publisher_name}-runtime-boundary"
  description = "Maximum permissions for enterprise release promotion and timestamp roles"
  policy      = data.aws_iam_policy_document.publisher_runtime_boundary.json
  tags        = local.tags
}

output "terraform_role_arn" {
  value = aws_iam_role.terraform.arn
}

output "publisher_runtime_boundary_arn" {
  value = aws_iam_policy.publisher_runtime_boundary.arn
}
