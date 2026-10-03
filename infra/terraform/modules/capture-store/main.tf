# ── Kortix Capture store ──────────────────────────────────────────────────────
#
# One private bucket per environment for the Kortix Capture format (schema 2,
# kortix-ai/capture apps/recorder/docs/capture-format.md). Devices write under
#   orgs/<account_id>/projects/<project_id>/<device_id>/
# with short-lived credentials the API issues: STS AssumeRole of the device
# role below with an inline session policy that narrows it to ONE device
# folder (apps/api/src/capture/credentials.ts). No long-lived credential for
# this bucket exists outside the API task role.
#
# Every `*.manifest.json` the devices write (an item is complete when its
# manifest lands) becomes an SQS message the API's leader worker turns into one
# idempotent ingest job. A device's index files are the fallback reader.
#
# Retention is the API's job (each project's policy.retention.remote_days); the
# lifecycle rule here is only a backstop above the 3650-day maximum, plus the
# cleanup of incomplete uploads and deleted versions.

#trivy:ignore:AVD-AWS-0089 Device uploads are authorized per device by STS session policies minted by the API; CloudTrail data events cover access when enabled.
resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_19:Encryption at rest is configured on aws_s3_bucket_server_side_encryption_configuration.this (SSE-S3); the legacy inline-block check cannot see the split resource.
  #checkov:skip=CKV_AWS_145:SSE-S3 so device uploads and presigned media reads need no KMS grant in every per-device session policy.
  #checkov:skip=CKV_AWS_18:Server access logging is not required; every access is a per-device STS session or an API presigned GET, logged by CloudTrail data events when enabled.
  #checkov:skip=CKV_AWS_144:Capture data is regional by design (data residency); cross-region replication is not wanted.
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

# Devices rewrite index/status/device.json; versioning keeps an overwrite or a
# delete reversible for noncurrent_version_days and satisfies the scanners.
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

#trivy:ignore:AVD-AWS-0132 SSE-S3 on purpose: a KMS key would need a grant in every per-device session policy.
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  #checkov:skip=CKV_AWS_145:SSE-S3 on purpose: a KMS key would need a grant in every per-device session policy.
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "capture-backstop"
    status = "Enabled"
    filter {}
    expiration {
      days = var.expiration_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

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

data "aws_iam_policy_document" "bucket" {
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
  policy = data.aws_iam_policy_document.bucket.json
}

# ── Manifest events ───────────────────────────────────────────────────────────

resource "aws_sqs_queue" "manifests_dlq" {
  name                      = "${var.name}-manifests-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "manifests" {
  name                       = "${var.name}-manifests"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.manifests_dlq.arn
    maxReceiveCount     = 10
  })
  tags = var.tags
}

data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "BucketSendsManifestEvents"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.manifests.arn]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.this.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "manifests" {
  queue_url = aws_sqs_queue.manifests.id
  policy    = data.aws_iam_policy_document.queue.json
}

resource "aws_s3_bucket_notification" "manifests" {
  bucket = aws_s3_bucket.this.id
  queue {
    queue_arn     = aws_sqs_queue.manifests.arn
    events        = ["s3:ObjectCreated:*"]
    filter_suffix = ".manifest.json"
  }
  depends_on = [aws_sqs_queue_policy.manifests]
}

# ── Device role ───────────────────────────────────────────────────────────────
# Assumed ONLY by the API task role, always with a session policy that narrows
# it to one device folder. This role's own policy is the ceiling: objects under
# orgs/ and a list of the bucket. The API chains roles, so a session lasts at
# most one hour.

data "aws_iam_policy_document" "device_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [var.api_task_role_arn]
    }
  }
}

resource "aws_iam_role" "device" {
  name                 = "${var.name}-device"
  assume_role_policy   = data.aws_iam_policy_document.device_trust.json
  max_session_duration = 3600
  tags                 = var.tags
}

resource "aws_iam_role_policy" "device" {
  name = "${var.name}-device"
  role = aws_iam_role.device.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "DeviceObjects"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
      Resource = "${aws_s3_bucket.this.arn}/orgs/*"
      }, {
      Sid      = "DeviceList"
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = aws_s3_bucket.this.arn
      Condition = {
        StringLike = { "s3:prefix" = ["orgs/*"] }
      }
    }]
  })
}
