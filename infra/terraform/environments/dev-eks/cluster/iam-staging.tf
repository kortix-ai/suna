# ── Staging runtime on the dev EKS control plane ─────────────────────────────
# Staging is isolated by branch, namespace, hostnames, IAM role, and Secrets
# Manager bundle, while sharing the already-running dev EKS control plane.
#
# This keeps staging available now without waiting on a separate cluster build.
# If/when staging gets its own EKS cluster, move these same trust/policy shapes to
# that cluster layer and keep the branch contract unchanged.

locals {
  staging_namespace       = "kortix-staging"
  staging_service_account = var.app_service_account
  staging_secret_arn      = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:kortix-staging-env-*"
  dev_secret_arn          = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:kortix-dev-env-*"
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "staging_ci_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        # workflow_run executes from the default branch workflow context even
        # though it deploys the successful staging branch build.
        "repo:${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_repo}:ref:refs/heads/staging",
      ]
    }
  }
}

resource "aws_iam_role" "staging_ci_deploy" {
  name               = "kortix-gha-eks-deploy-staging"
  assume_role_policy = data.aws_iam_policy_document.staging_ci_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "staging_ci_deploy" {
  name = "kortix-gha-eks-deploy-staging-deploy"
  role = aws_iam_role.staging_ci_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["eks:DescribeCluster"]
        Resource = module.eks.cluster_arn
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ]
        Resource = [
          local.dev_secret_arn,
          local.staging_secret_arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_eks_access_entry" "staging_ci_deploy" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.staging_ci_deploy.arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "staging_ci_admin" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.staging_ci_deploy.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.staging_ci_deploy]
}

data "aws_iam_policy_document" "staging_app_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider_url}:sub"
      values   = ["system:serviceaccount:${local.staging_namespace}:${local.staging_service_account}"]
    }
  }
}

resource "aws_iam_role" "staging_app" {
  name               = "kortix-staging-eks-app"
  assume_role_policy = data.aws_iam_policy_document.staging_app_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "staging_app_secrets_read" {
  name = "kortix-staging-eks-app-secrets-read"
  role = aws_iam_role.staging_app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ]
      Resource = local.staging_secret_arn
    }]
  })
}

output "staging_ci_deploy_role_arn" {
  value = aws_iam_role.staging_ci_deploy.arn
}

output "staging_app_irsa_role_arn" {
  value = aws_iam_role.staging_app.arn
}
