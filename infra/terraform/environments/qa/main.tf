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
  region = var.region
}

# Reads CLOUDFLARE_API_TOKEN from the environment — never put the token in a file.
provider "cloudflare" {}

variable "region" {
  type    = string
  default = "us-west-2"
}

variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  type = string
}

variable "alb_hostname" {
  description = "Dev ALB DNS name the qa.kortix.com record CNAMEs to (from `kubectl -n kortix-qa get ingress qa-portal`). Update if the ALB is recreated."
  type        = string
  default     = "k8s-kortixqaportal-8ff35a5ffe-699499126.us-west-2.elb.amazonaws.com"
}

variable "manage_dns_record" {
  description = "Terraform owns the qa.kortix.com Cloudflare record. Keep true so applies don't drop it."
  type        = bool
  default     = true
}

module "qa_portal" {
  source = "../../modules/qa-portal"

  name        = "qa-portal"
  bucket_name = "kortix-qa-reports"

  oidc_provider_arn = "arn:aws:iam::935064898258:oidc-provider/oidc.eks.us-west-2.amazonaws.com/id/01F423916879E83FBF85E4540EA8E868"
  oidc_provider_url = "oidc.eks.us-west-2.amazonaws.com/id/01F423916879E83FBF85E4540EA8E868"

  namespace       = "kortix-qa"
  service_account = "qa-portal"

  host = "qa.kortix.com"

  manage_dns_record = var.manage_dns_record
  dns_zone_id       = var.cloudflare_zone_id
  alb_hostname      = var.alb_hostname

  enable_access                = true
  create_access_policy         = false # account attaches reusable "kortix internal" org policies
  cloudflare_account_id        = var.cloudflare_account_id
  access_allowed_email_domains = ["kortix.com"]

  tags = {
    Project   = "kortix"
    Component = "qa-portal"
    ManagedBy = "terraform"
    Cluster   = "kortix-dev-eks"
  }
}

output "bucket_name" {
  value = module.qa_portal.bucket_name
}

output "role_arn" {
  value = module.qa_portal.role_arn
}

output "access_application_id" {
  value = module.qa_portal.access_application_id
}

# ── GitHub Actions OIDC role that publishes QA reports to the bucket ──────────
# Trusts the kortix-ai/suna main/prod branches (qa-main) and pull_requests
# (qa-pr/qa-release per-PR reports). Least privilege: S3 write under reports/*
# of the QA bucket only. Used as QA_REPORTS_ROLE_ARN in the qa workflows.
data "aws_iam_policy_document" "qa_publisher_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::935064898258:oidc-provider/token.actions.githubusercontent.com"]
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
        "repo:kortix-ai/suna:ref:refs/heads/main",
        "repo:kortix-ai/suna:ref:refs/heads/prod",
        "repo:kortix-ai/suna:pull_request",
      ]
    }
  }
}

resource "aws_iam_role" "qa_publisher" {
  name               = "kortix-qa-publisher"
  assume_role_policy = data.aws_iam_policy_document.qa_publisher_assume.json
  tags = {
    Project   = "kortix"
    Component = "qa-portal"
    ManagedBy = "terraform"
  }
}

data "aws_iam_policy_document" "qa_publisher_write" {
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = ["arn:aws:s3:::${module.qa_portal.bucket_name}"]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${module.qa_portal.bucket_name}/reports/*"]
  }
}

resource "aws_iam_role_policy" "qa_publisher_write" {
  name   = "qa-publisher-write"
  role   = aws_iam_role.qa_publisher.id
  policy = data.aws_iam_policy_document.qa_publisher_write.json
}

output "qa_publisher_role_arn" {
  value = aws_iam_role.qa_publisher.arn
}
