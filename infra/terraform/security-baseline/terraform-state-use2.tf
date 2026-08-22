# Regional state backend for the US East 2 production shadow root.
#
# The account-wide Terraform roots continue to use the shared US West 2
# backend. This bucket and lock table keep the US East 2 production state in
# the same region as its managed infrastructure.
# trivy:ignore:AVD-AWS-0089
resource "aws_s3_bucket" "terraform_state_use2" {
  # checkov:skip=CKV_AWS_18:CloudTrail and S3 version history audit state access. A second access-log bucket adds another state-bearing bucket.
  # checkov:skip=CKV2_AWS_62:The state backend has no event-notification consumer. Terraform locking and CI plans detect state changes.
  # checkov:skip=CKV_AWS_144:The production migration requires all state to remain in us-east-2. Versioning and the regional archive provide recovery.
  provider = aws.use2

  bucket = "kortix-terraform-state-us-east-2-935064898258"

  tags = merge(local.tags, {
    Name   = "kortix-terraform-state-us-east-2"
    Region = "us-east-2"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "terraform_state_use2" {
  provider = aws.use2

  description             = "KMS key for the US East 2 Terraform state backend"
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

  tags = merge(local.tags, {
    Name   = "kortix-terraform-state-us-east-2"
    Region = "us-east-2"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "terraform_state_use2" {
  provider = aws.use2

  name          = "alias/kortix-terraform-state-us-east-2"
  target_key_id = aws_kms_key.terraform_state_use2.key_id
}

resource "aws_s3_bucket_versioning" "terraform_state_use2" {
  provider = aws.use2

  bucket = aws_s3_bucket.terraform_state_use2.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state_use2" {
  provider = aws.use2

  bucket = aws_s3_bucket.terraform_state_use2.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.terraform_state_use2.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state_use2" {
  provider = aws.use2

  bucket = aws_s3_bucket.terraform_state_use2.id

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

  depends_on = [aws_s3_bucket_versioning.terraform_state_use2]
}

resource "aws_s3_bucket_public_access_block" "terraform_state_use2" {
  provider = aws.use2

  bucket                  = aws_s3_bucket.terraform_state_use2.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

data "aws_iam_policy_document" "terraform_state_use2" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.terraform_state_use2.arn,
      "${aws_s3_bucket.terraform_state_use2.arn}/*",
    ]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "terraform_state_use2" {
  provider = aws.use2

  bucket = aws_s3_bucket.terraform_state_use2.id
  policy = data.aws_iam_policy_document.terraform_state_use2.json
}

resource "aws_dynamodb_table" "terraform_locks_use2" {
  provider = aws.use2

  name                        = "kortix-terraform-locks-us-east-2"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "LockID"
  deletion_protection_enabled = true

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.terraform_state_use2.arn
  }

  tags = merge(local.tags, {
    Name   = "kortix-terraform-locks-us-east-2"
    Region = "us-east-2"
  })

  lifecycle {
    prevent_destroy = true
  }
}
