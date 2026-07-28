# Velero protects reconstructable in-cluster state in the production EKS
# cluster. Customer application data remains outside the cluster.

data "terraform_remote_state" "prod_eks_cluster" {
  backend = "s3"
  config = {
    bucket         = "kortix-terraform-state"
    key            = "prod-eks/cluster.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
  }
}

locals {
  prod_eks_cluster = data.terraform_remote_state.prod_eks_cluster.outputs
  velero_bucket    = "kortix-velero-backups"
}

data "aws_iam_policy_document" "velero_kms" {
  # checkov:skip=CKV_AWS_109:The account-root statement is the required KMS key control plane.
  # checkov:skip=CKV_AWS_111:The account root must administer this KMS key.
  # checkov:skip=CKV_AWS_356:KMS key policies require Resource "*" because the key ARN does not exist during policy evaluation.
  statement {
    sid = "EnableAccountAdministration"
    actions = [
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:DisableKey",
      "kms:DisableKeyRotation",
      "kms:EnableKey",
      "kms:EnableKeyRotation",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyPair",
      "kms:GenerateDataKeyPairWithoutPlaintext",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:GetPublicKey",
      "kms:ListGrants",
      "kms:ListKeyPolicies",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
      "kms:ReplicateKey",
      "kms:RetireGrant",
      "kms:RevokeGrant",
      "kms:ScheduleKeyDeletion",
      "kms:Sign",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateKeyDescription",
      "kms:UpdatePrimaryRegion",
      "kms:Verify",
    ]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "velero" {
  provider                = aws.euw2
  description             = "Encrypts production Velero backup objects"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.velero_kms.json
  tags                    = local.tags
}

resource "aws_kms_alias" "velero" {
  provider      = aws.euw2
  name          = "alias/kortix-velero"
  target_key_id = aws_kms_key.velero.key_id
}

resource "aws_s3_bucket" "velero" {
  provider = aws.euw2

  # checkov:skip=CKV_AWS_18:CloudTrail records account-level S3 operations; a second access-log bucket would add another unprotected backup dependency.
  # checkov:skip=CKV_AWS_144:Velero contains reconstructable cluster state only; Terraform and Git remain the cross-region recovery sources.
  # checkov:skip=CKV2_AWS_62:Velero validates the backup storage location and owns backup lifecycle; no separate object-event consumer exists.
  bucket        = local.velero_bucket
  force_destroy = false
  tags          = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "velero" {
  provider = aws.euw2
  bucket   = aws_s3_bucket.velero.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "velero" {
  provider                = aws.euw2
  bucket                  = aws_s3_bucket.velero.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "velero" {
  provider = aws.euw2
  bucket   = aws_s3_bucket.velero.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "velero" {
  provider = aws.euw2
  bucket   = aws_s3_bucket.velero.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.velero.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "velero" {
  provider = aws.euw2
  bucket   = aws_s3_bucket.velero.id

  rule {
    id     = "backup-version-retention"
    status = "Enabled"
    filter {}

    expiration {
      days = 35
    }

    noncurrent_version_expiration {
      noncurrent_days = 35
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.velero]
}

data "aws_iam_policy_document" "velero_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.velero.arn, "${aws_s3_bucket.velero.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "velero" {
  provider = aws.euw2
  bucket   = aws_s3_bucket.velero.id
  policy   = data.aws_iam_policy_document.velero_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.velero]
}

data "aws_iam_policy_document" "velero_assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.prod_eks_cluster.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.prod_eks_cluster.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.prod_eks_cluster.oidc_provider_url}:sub"
      values   = ["system:serviceaccount:velero:velero-server"]
    }
  }
}

resource "aws_iam_role" "velero" {
  name               = "kortix-velero"
  assume_role_policy = data.aws_iam_policy_document.velero_assume_role.json
  tags               = local.tags
}

data "aws_iam_policy_document" "velero" {
  # checkov:skip=CKV_AWS_356:Velero's EC2 snapshot create and describe APIs do not support complete resource-level scoping.
  # checkov:skip=CKV_AWS_111:Velero must create snapshots and volumes. AWS does not support complete resource constraints for these create APIs.
  statement {
    sid = "ManageVolumeSnapshots"
    actions = [
      "ec2:CreateSnapshot",
      "ec2:CreateTags",
      "ec2:CreateVolume",
      "ec2:DeleteSnapshot",
      "ec2:DescribeSnapshots",
      "ec2:DescribeVolumes",
    ]
    resources = ["*"]
  }

  statement {
    sid = "ManageBackupObjects"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
      "s3:PutObjectTagging",
    ]
    resources = ["${aws_s3_bucket.velero.arn}/*"]
  }

  statement {
    sid       = "ListBackupBucket"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket"]
    resources = [aws_s3_bucket.velero.arn]
  }

  statement {
    sid = "UseBackupEncryptionKey"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = [aws_kms_key.velero.arn]
  }
}

resource "aws_iam_role_policy" "velero" {
  name   = "ManageProductionClusterBackups"
  role   = aws_iam_role.velero.id
  policy = data.aws_iam_policy_document.velero.json
}
