# ── QA report portal: durable S3 store + IRSA read role ───────────────────────
#
# A never-lost home for Allure QA reports:
#   s3://<bucket>/reports/runs/<run-id>/   per-run results + generated report (history)
#   s3://<bucket>/reports/latest/          the latest generated static report (served)
#
# Versioning is ON (every write is recoverable), public access is fully blocked
# (the report is served by the in-cluster nginx pod, never straight from S3), and
# a lifecycle rule expires stale per-run reports + old versions so the bucket
# doesn't grow without bound. The portal pod reads via IRSA; CI writes via its
# own role. No static AWS keys anywhere.

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

# ── Bucket ────────────────────────────────────────────────────────────────────
# QA report artifacts are non-sensitive and fully regenerable from CI. SSE-S3
# (AES256) is enabled below; a customer-managed KMS key, cross-region
# replication, access logging, and event notifications add cost and key/ops
# management with no benefit for this data class — accepted-risk, documented.
#trivy:ignore:AVD-AWS-0089
resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_145:non-sensitive regenerable CI artifacts; SSE-S3 (AES256) is sufficient, a CMK adds needless key management
  #checkov:skip=CKV_AWS_18:access logging on an internal QA-artifact bucket is low value and only adds another bucket
  #checkov:skip=CKV_AWS_144:cross-region replication is unnecessary for regenerable CI reports
  #checkov:skip=CKV2_AWS_62:event notifications are not consumed by the portal sync sidecar
  bucket = var.bucket_name
  tags   = var.tags
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Block ALL public access — the report is served only through the EKS pod.
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3 (AES256) — non-sensitive regenerable CI artifacts don't warrant a CMK.
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Keep latest + recent history; expire stale per-run reports and old versions.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # Per-run reports/results age out after N days. reports/latest/ is excluded by
  # prefix so the currently-served report is never expired.
  rule {
    id     = "expire-old-runs"
    status = "Enabled"
    filter {
      prefix = "reports/runs/"
    }
    expiration {
      days = var.per_run_retention_days
    }
  }

  # Per-PR reports (reports/pr/<n>/<run>/) age out too — without this they
  # accumulate forever (every PR run uploads a full report), which is what grew
  # the bucket without bound. The landing page only surfaces the newest runs.
  rule {
    id     = "expire-old-pr-reports"
    status = "Enabled"
    filter {
      prefix = "reports/pr/"
    }
    expiration {
      days = var.pr_report_retention_days
    }
  }

  # Versioning recoverability without unbounded growth: drop overwritten versions
  # after N days, and clean up incomplete multipart uploads.
  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# ── IRSA read role for the portal pod ─────────────────────────────────────────
# Mirrors modules/eks/irsa: only system:serviceaccount:<ns>:<sa> may assume it.
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
      values   = ["system:serviceaccount:${var.namespace}:${var.service_account}"]
    }
  }
}

resource "aws_iam_role" "portal" {
  name               = var.name
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

# Read-only: list the bucket + get objects (the sidecar runs `aws s3 sync`).
data "aws_iam_policy_document" "portal_read" {
  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.this.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["reports/*"]
    }
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.this.arn}/reports/*"]
  }
}

resource "aws_iam_role_policy" "portal_read" {
  name   = "${var.name}-read"
  role   = aws_iam_role.portal.id
  policy = data.aws_iam_policy_document.portal_read.json
}

# ── CI writer policy (optional) ───────────────────────────────────────────────
# Attach write to an EXISTING CI role (assumed via GitHub OIDC). We attach a
# policy to that role rather than minting a new role, so the CI identity stays
# defined where the rest of CI access lives.
data "aws_iam_policy_document" "ci_write" {
  count = var.ci_writer_role_arn == "" ? 0 : 1

  statement {
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.this.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.this.arn}/reports/*"]
  }
}

resource "aws_iam_role_policy" "ci_write" {
  count = var.ci_writer_role_arn == "" ? 0 : 1
  name  = "${var.name}-ci-write"
  # The role NAME is the last path segment of the ARN.
  role   = element(split("/", var.ci_writer_role_arn), length(split("/", var.ci_writer_role_arn)) - 1)
  policy = data.aws_iam_policy_document.ci_write[0].json
}

# ── DNS (optional, single record) ─────────────────────────────────────────────
# Off by default — the chart's external-dns annotation creates the proxied record
# from the Ingress. Set manage_dns_record=true to have Terraform own it instead.
module "dns" {
  count   = var.manage_dns_record ? 1 : 0
  source  = "../cloudflare-dns"
  zone_id = var.dns_zone_id
  records = {
    qa = {
      name    = var.host
      type    = "CNAME"
      value   = var.alb_hostname
      proxied = true
      ttl     = 1 # proxied records must use ttl=1
    }
  }
}
