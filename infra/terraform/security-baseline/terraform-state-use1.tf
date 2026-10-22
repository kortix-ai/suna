# Regional state backend for Terraform roots whose resources live in us-east-1.
# Today that is one external root: kortix-ai/kortix-vps-demo-infra (key
# `vps-demo/terraform.tfstate`). Same shape as the eu-west-2 backend
# (terraform-state-euw2.tf): S3 native locking (`use_lockfile`), no lock table.
# trivy:ignore:AVD-AWS-0089
resource "aws_s3_bucket" "terraform_state_use1" {
  # checkov:skip=CKV_AWS_18:CloudTrail and S3 version history audit state access. A second access-log bucket adds another state-bearing bucket.
  # checkov:skip=CKV2_AWS_62:The state backend has no event-notification consumer. Terraform locking and CI plans detect state changes.
  # checkov:skip=CKV_AWS_144:us-east-1 state stays in us-east-1. Versioning and the regional archive provide recovery.
  provider = aws.use1

  bucket = "kortix-terraform-state-us-east-1-935064898258"

  tags = {
    ManagedBy  = "terraform"
    Stack      = "security-baseline"
    Compliance = "soc2"
    Name       = "kortix-terraform-state-us-east-1"
    Region     = "us-east-1"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "terraform_state_use1" {
  provider = aws.use1

  description             = "KMS key for the US East 1 Terraform state backend"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "EnableIAMPermissions"
      Effect = "Allow"
      Principal = {
        AWS = "arn:aws:iam::${local.account_id}:root"
      }
      Action = [
        "kms:CancelKeyDeletion",
        "kms:CreateAlias",
        "kms:CreateGrant",
        "kms:Decrypt",
        "kms:DeleteAlias",
        "kms:DescribeKey",
        "kms:DisableKey",
        "kms:DisableKeyRotation",
        "kms:EnableKey",
        "kms:EnableKeyRotation",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:GenerateDataKeyWithoutPlaintext",
        "kms:GetKeyPolicy",
        "kms:GetKeyRotationStatus",
        "kms:ListAliases",
        "kms:ListGrants",
        "kms:ListKeyPolicies",
        "kms:ListKeyRotations",
        "kms:ListResourceTags",
        "kms:ListRetirableGrants",
        "kms:PutKeyPolicy",
        "kms:ReEncryptFrom",
        "kms:ReEncryptTo",
        "kms:RetireGrant",
        "kms:RevokeGrant",
        "kms:RotateKeyOnDemand",
        "kms:ScheduleKeyDeletion",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:UpdateAlias",
        "kms:UpdateKeyDescription",
      ]
      Resource = "*"
    }]
  })

  tags = {
    ManagedBy  = "terraform"
    Stack      = "security-baseline"
    Compliance = "soc2"
    Name       = "kortix-terraform-state-us-east-1"
    Region     = "us-east-1"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "terraform_state_use1" {
  provider = aws.use1

  name          = "alias/kortix-terraform-state-us-east-1"
  target_key_id = aws_kms_key.terraform_state_use1.key_id
}

resource "aws_s3_bucket_versioning" "terraform_state_use1" {
  provider = aws.use1

  bucket = aws_s3_bucket.terraform_state_use1.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state_use1" {
  provider = aws.use1

  bucket = aws_s3_bucket.terraform_state_use1.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_state_use1.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state_use1" {
  provider = aws.use1

  bucket = aws_s3_bucket.terraform_state_use1.id

  rule {
    id     = "state-version-retention"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }

    noncurrent_version_expiration {
      noncurrent_days = 365
    }
  }

  depends_on = [aws_s3_bucket_versioning.terraform_state_use1]
}

resource "aws_s3_bucket_public_access_block" "terraform_state_use1" {
  provider = aws.use1

  bucket                  = aws_s3_bucket.terraform_state_use1.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "terraform_state_use1" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.terraform_state_use1.arn,
      "${aws_s3_bucket.terraform_state_use1.arn}/*",
    ]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state_use1" {
  provider = aws.use1

  bucket = aws_s3_bucket.terraform_state_use1.id
  policy = data.aws_iam_policy_document.terraform_state_use1.json
}
