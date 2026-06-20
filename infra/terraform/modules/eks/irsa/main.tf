# Reusable IRSA (IAM Roles for Service Accounts) role.
#
# Given the cluster's OIDC provider and a (namespace, service-account) pair, this
# mints an IAM role that ONLY that Kubernetes ServiceAccount can assume — the
# least-privilege way for an in-cluster pod (a controller, or the app) to call
# AWS APIs with no static credentials. Attach permissions via policy_json
# (inline) and/or policy_arns (managed). Used by the ALB controller,
# cluster-autoscaler, and the app's secret-reading SA.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  # Subjects this role trusts: system:serviceaccount:<ns>:<sa> for each SA.
  subjects = [for sa in var.service_accounts : "system:serviceaccount:${var.namespace}:${sa}"]
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:sub"
      values   = local.subjects
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.name
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = var.max_session_duration
  tags                 = var.tags
}

resource "aws_iam_role_policy" "inline" {
  count  = var.policy_json == "" ? 0 : 1
  name   = "${var.name}-inline"
  role   = aws_iam_role.this.id
  policy = var.policy_json
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each   = toset(var.policy_arns)
  role       = aws_iam_role.this.name
  policy_arn = each.value
}
