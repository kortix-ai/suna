# ── GitHub Actions OIDC deploy role + EKS access ──────────────────────────────
# Mirrors the existing `kortix-gha-ecs-deploy` role (out-of-band today) but for
# EKS, and managed here in code per the brief. CI assumes this via OIDC (no
# static keys) to run `helm upgrade` against the cluster. Two halves:
#   1. IAM: trust GitHub OIDC for the repo + permission to DescribeCluster
#      (all `update-kubeconfig` needs).
#   2. EKS access entry: the Kubernetes RBAC — cluster-wide READ + write ONLY in
#      the app namespace, so a deploy can roll the app but can't touch platform
#      controllers or other namespaces.

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "ci_assume" {
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
    # Restrict to the prod branch of the canonical repo (mirrors the ECS role's
    # repo, tightened to the branch that actually deploys prod).
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/prod"]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = var.ci_deploy_role_name
  assume_role_policy = data.aws_iam_policy_document.ci_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "ci_describe_cluster" {
  name = "${var.ci_deploy_role_name}-describe"
  role = aws_iam_role.ci_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["eks:DescribeCluster"]
      Resource = module.eks.cluster_arn
    }]
  })
}

# ── Kubernetes RBAC via EKS access entries ────────────────────────────────────
resource "aws_eks_access_entry" "ci_deploy" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.ci_deploy.arn
  type          = "STANDARD"
}

# Cluster-wide read (lets helm discover CRDs / existing objects safely)...
resource "aws_eks_access_policy_association" "ci_view" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.ci_deploy.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminViewPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.ci_deploy]
}

# ...but write only inside the app namespace.
resource "aws_eks_access_policy_association" "ci_app_admin" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.ci_deploy.arn
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSAdminPolicy"
  access_scope {
    type       = "namespace"
    namespaces = [var.app_namespace]
  }
  depends_on = [aws_eks_access_entry.ci_deploy]
}

# ── Optional extra human cluster-admins ───────────────────────────────────────
# (The principal that runs `terraform apply` is already a cluster admin via
# bootstrap_cluster_creator_admin_permissions.)
resource "aws_eks_access_entry" "admins" {
  for_each      = toset(var.admin_principal_arns)
  cluster_name  = module.eks.cluster_name
  principal_arn = each.value
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "admins" {
  for_each      = toset(var.admin_principal_arns)
  cluster_name  = module.eks.cluster_name
  principal_arn = each.value
  policy_arn    = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.admins]
}
