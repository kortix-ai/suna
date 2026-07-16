# ── PR preview environments (ephemeral per-PR API on dev-eks) ─────────────────
# Each open PR labeled `preview` gets a kortix-pr-<n> namespace (created by Argo
# CD) running the API against the shared dev data plane via the kortix-preview-env
# bundle. AWS prerequisites:
#   1. a wildcard ACM cert for *.preview-api.kortix.com (one shared preview ALB), and
#   2. an IRSA role any kortix-pr-*/kortix-api ServiceAccount can assume to read
#      kortix-preview-env — StringLike on the OIDC sub, since the wildcard
#      namespace can't be expressed by the exact-match modules/eks/irsa.

locals {
  preview_secret_name     = "kortix-preview-env"
  preview_wildcard_domain = "*.preview-api.kortix.com"
  # Any preview namespace's app SA: system:serviceaccount:kortix-pr-<n>:kortix-api
  preview_sa_subject = "system:serviceaccount:kortix-pr-*:${var.app_service_account}"
}

# Wildcard cert for the shared preview ALB (all PR hosts served via SNI).
module "acm_preview" {
  source      = "../../../modules/acm-cloudflare"
  domain_name = local.preview_wildcard_domain
  zone_id     = var.cloudflare_zone_id
  tags        = local.tags
  providers = {
    aws        = aws
    cloudflare = cloudflare
  }
}

data "aws_secretsmanager_secret" "preview_env" {
  name = local.preview_secret_name
}

data "aws_iam_policy_document" "preview_assume" {
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
    # Wildcard namespace — trusts every ephemeral kortix-pr-<n> preview's app SA.
    condition {
      test     = "StringLike"
      variable = "${module.eks.oidc_provider_url}:sub"
      values   = [local.preview_sa_subject]
    }
  }
}

data "aws_iam_policy_document" "preview_secrets_read" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [data.aws_secretsmanager_secret.preview_env.arn]
  }
}

resource "aws_iam_role" "preview_app" {
  name               = "${local.name}-preview-app"
  assume_role_policy = data.aws_iam_policy_document.preview_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "preview_secrets_read" {
  name   = "${local.name}-preview-secrets-read"
  role   = aws_iam_role.preview_app.id
  policy = data.aws_iam_policy_document.preview_secrets_read.json
}

output "preview_app_irsa_role_arn" {
  description = "IRSA role any kortix-pr-*/kortix-api SA assumes to read kortix-preview-env."
  value       = aws_iam_role.preview_app.arn
}

output "acm_preview_certificate_arn" {
  description = "Wildcard cert for *.preview-api.kortix.com (shared preview ALB ingress annotation)."
  value       = module.acm_preview.certificate_arn
}
