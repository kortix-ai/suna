# ── Project snapshot object store ─────────────────────────────────────────────
#
# One private bucket per environment for the S3 config provider
# (docs/runbooks/project-snapshot-s3.md). The API's leader worker publishes two
# immutable objects per (repo, commit) under
#   <prefix><owner>/<repo>/<sha>/<repo-id>/project-snapshot-v2/{manifest.json,
#   <sha256>.tree.tar.gz, <sha256>.blobs.pack}
# with conditional writes (If-None-Match: *) — nothing is ever overwritten.
# Sandboxes read through short-lived presigned GETs minted by the API task
# role; no credential for this bucket exists outside that role.
#
# Objects are derived data: the repository is the source of truth, and a
# missing object degrades a boot to the Git path (the descriptor re-queues the
# ledger row). That is what makes the expiration rule below safe.

#trivy:ignore:AVD-AWS-0089 Derived, short-lived snapshot objects; access is presigned GETs minted by the API task role, not worth a second log bucket.
resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_18:Server access logging is not required for derived, short-lived project snapshots; every access is a presigned GET minted by the API task role and logged by CloudTrail data events when enabled.
  #checkov:skip=CKV_AWS_144:Snapshots are regional derived data rebuilt from Git on demand; cross-region replication is not required.
  #checkov:skip=CKV2_AWS_62:Snapshot objects have no event consumer; readiness lives in the API's ledger table.
  bucket        = var.name
  force_destroy = var.force_destroy
  tags          = merge(var.tags, { Name = var.name })
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Immutable, revision-addressed objects never need a second version, but
# versioning keeps a delete (lifecycle or operator) reversible for a short
# window and satisfies the baseline scanners; noncurrent versions expire fast.
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

#trivy:ignore:AVD-AWS-0132 SSE-S3 by default; pass kms_key_arn for a customer-managed key (the API task role is then granted use of it).
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  #checkov:skip=CKV_AWS_145:SSE-S3 by default so presigned sandbox downloads need no KMS context; kms_key_arn switches the bucket to a customer-managed key.
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn != "" ? "aws:kms" : "AES256"
      kms_master_key_id = var.kms_key_arn != "" ? var.kms_key_arn : null
    }
    bucket_key_enabled = var.kms_key_arn != "" ? true : null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "snapshot-retention"
    status = "Enabled"
    filter {}
    dynamic "expiration" {
      for_each = var.expiration_days > 0 ? [1] : []
      content {
        days = var.expiration_days
      }
    }
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
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

  depends_on = [aws_s3_bucket_versioning.this]
}

data "aws_iam_policy_document" "this" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"]
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

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.this.json

  depends_on = [aws_s3_bucket_public_access_block.this]
}
