# ── Audit-event archive ───────────────────────────────────────────────────────
#
# WORM store for kortix.audit_events. The API job exports each weekly partition
# older than the 90-day hot window as gzip JSONL and writes it with Object Lock
# retention until occurred_at + 365 days. A lifecycle rule deletes current objects
# at retention_days - archive_lag_days + 1 days after upload (about 365 days after the event); the privacy policy keeps application logs up to 365
# days. The API task role may write and read, never delete (modules/ecs-api).
#
# COMPLIANCE mode is irreversible for each written object version: nobody,
# including the account root, can shorten retention or delete it early.

#trivy:ignore:AVD-AWS-0089 Write-once archive reached only by the API task role; CloudTrail data events cover object access when enabled. No log bucket exists to receive S3 server access logs.
resource "aws_s3_bucket" "audit_archive" {
  #checkov:skip=CKV_AWS_19:Encryption at rest is configured on aws_s3_bucket_server_side_encryption_configuration.audit_archive (SSE-KMS); the legacy inline-block check cannot see the split resource.
  #checkov:skip=CKV_AWS_18:No shared S3 access-log bucket exists in this repo; Object Lock plus CloudTrail data events cover access auditing.
  #checkov:skip=CKV_AWS_144:The archive is a regional, single-writer store; cross-region replication is not required.
  #checkov:skip=CKV2_AWS_62:The archive has no event consumer.
  bucket              = var.name
  object_lock_enabled = true
  force_destroy       = false
  tags                = merge(var.tags, { Name = var.name })
}

resource "aws_s3_bucket_public_access_block" "audit_archive" {
  bucket                  = aws_s3_bucket.audit_archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  rule {
    default_retention {
      mode = var.object_lock_mode
      days = var.retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit_archive]
}

# ── Encryption key ────────────────────────────────────────────────────────────
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

data "aws_iam_policy_document" "key" {
  #checkov:skip=CKV_AWS_109:Account-root delegation is the standard key-policy root statement; it only enables IAM policies. Use of the key is granted per principal (modules/ecs-api grants the API task role GenerateDataKey/Decrypt only).
  #checkov:skip=CKV_AWS_111:Same root-delegation statement; no write access is granted to any other principal here.
  #checkov:skip=CKV_AWS_356:In a key policy "*" resource means this key.
  statement {
    sid       = "EnableIamPolicies"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
}

resource "aws_kms_key" "audit_archive" {
  description             = "${var.name} audit archive encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.key.json
  tags                    = merge(var.tags, { Name = "${var.name}-audit-archive" })
}

resource "aws_kms_alias" "audit_archive" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.audit_archive.key_id
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.audit_archive.arn
    }
    bucket_key_enabled = true
  }
}

# Object Lock blocks deletion before each version's retention ends, so these
# rules only act once retention has passed. +1 day keeps the expiry after the
# last lock: the API sets retain-until = week end + 365 days, which is at most
# retention_days - archive_lag_days after the upload (it only uploads weeks older than
# archive_lag_days). Expiry therefore counts from the upload, not from the default retention.
resource "aws_s3_bucket_lifecycle_configuration" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id

  rule {
    id     = "audit-archive-retention"
    status = "Enabled"
    filter {}
    expiration {
      days = var.retention_days - var.archive_lag_days + 1
    }
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # Delete markers left by expired current versions must not accumulate.
  rule {
    id     = "expired-delete-markers"
    status = "Enabled"
    filter {}
    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.audit_archive]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.audit_archive.arn, "${aws_s3_bucket.audit_archive.arn}/*"]
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

  # StringNotEquals is also true when the header is absent, so a PutObject that
  # omits x-amz-server-side-encryption is denied too.
  statement {
    sid       = "DenyPutWithoutKmsEncryption"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit_archive.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }
}

resource "aws_s3_bucket_policy" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.audit_archive]
}
