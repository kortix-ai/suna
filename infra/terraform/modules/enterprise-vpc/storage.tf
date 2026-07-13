locals {
  bucket_prefix = substr("${var.name}-${var.expected_account_id}-${local.region}", 0, 44)
}

resource "aws_s3_bucket" "backups" {
  #checkov:skip=CKV_AWS_144:Customer backups remain in the selected residency region; AWS Backup vault lock, hourly EBS recovery points, WAL objects, and versioning provide independent recovery layers.
  #checkov:skip=CKV_AWS_18:Object-level CloudTrail data events below provide authenticated access audit records without a recursive server-access-log bucket.
  #checkov:skip=CKV2_AWS_62:CloudTrail data events and the encrypted alert topic are the installation-wide detection path.
  bucket        = "${local.bucket_prefix}-backups"
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket" "release_cache" {
  #checkov:skip=CKV_AWS_144:This is a reproducible cache of signed upstream artifacts and intentionally remains in-region.
  #checkov:skip=CKV_AWS_18:Object-level CloudTrail data events below audit all accesses.
  #checkov:skip=CKV2_AWS_62:CloudTrail data events are the central notification and audit path.
  bucket        = "${local.bucket_prefix}-releases"
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket" "audit" {
  #checkov:skip=CKV_AWS_144:Audit evidence remains in the customer-selected residency region and is protected with KMS, validation, versioning, and archival lifecycle.
  #checkov:skip=CKV_AWS_18:Logging the CloudTrail destination to itself would recurse; log-file validation provides integrity and the trail captures protected-bucket data events.
  #checkov:skip=CKV2_AWS_62:CloudTrail publishes delivery notifications to the encrypted SNS topic configured below.
  bucket        = "${local.bucket_prefix}-audit"
  force_destroy = false
  tags          = local.tags
}

locals {
  protected_buckets = {
    backups       = aws_s3_bucket.backups.id
    release_cache = aws_s3_bucket.release_cache.id
    audit         = aws_s3_bucket.audit.id
  }
}

resource "aws_s3_bucket_public_access_block" "protected" {
  for_each = local.protected_buckets
  bucket   = each.value

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "protected" {
  for_each = local.protected_buckets
  bucket   = each.value
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "protected" {
  for_each = local.protected_buckets
  bucket   = each.value

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.data.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

data "aws_iam_policy_document" "bucket_transport" {
  for_each = local.protected_buckets

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      "arn:${local.partition}:s3:::${each.value}",
      "arn:${local.partition}:s3:::${each.value}/*",
    ]
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

  dynamic "statement" {
    for_each = each.key == "audit" ? [1] : []
    content {
      sid       = "CloudTrailAclCheck"
      effect    = "Allow"
      actions   = ["s3:GetBucketAcl"]
      resources = ["arn:${local.partition}:s3:::${each.value}"]
      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceArn"
        values   = ["arn:${local.partition}:cloudtrail:${local.region}:${var.expected_account_id}:trail/${var.name}"]
      }
    }
  }

  dynamic "statement" {
    for_each = each.key == "audit" ? [1] : []
    content {
      sid       = "CloudTrailWrite"
      effect    = "Allow"
      actions   = ["s3:PutObject"]
      resources = ["arn:${local.partition}:s3:::${each.value}/AWSLogs/${var.expected_account_id}/*"]
      principals {
        type        = "Service"
        identifiers = ["cloudtrail.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "s3:x-amz-acl"
        values   = ["bucket-owner-full-control"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceArn"
        values   = ["arn:${local.partition}:cloudtrail:${local.region}:${var.expected_account_id}:trail/${var.name}"]
      }
    }
  }
}

resource "aws_s3_bucket_policy" "bucket_transport" {
  for_each = local.protected_buckets
  bucket   = each.value
  policy   = data.aws_iam_policy_document.bucket_transport[each.key].json
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "retain-and-archive"
    status = "Enabled"

    filter {}

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    expiration {
      days = var.backup_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.backup_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "release_cache" {
  bucket = aws_s3_bucket.release_cache.id

  rule {
    id     = "expire-noncurrent-release-cache"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit" {
  bucket = aws_s3_bucket.audit.id

  rule {
    id     = "archive-audit"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = 365
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_ecr_repository" "enterprise" {
  for_each             = var.image_repositories
  name                 = "${var.name}/${each.value}"
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "enterprise" {
  for_each   = aws_ecr_repository.enterprise
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the most recent 30 immutable enterprise artifacts"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_cloudtrail" "operations" {
  name                          = var.name
  s3_bucket_name                = aws_s3_bucket.audit.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  kms_key_id                    = aws_kms_key.data.arn
  cloud_watch_logs_group_arn    = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn     = aws_iam_role.cloudtrail.arn
  sns_topic_name                = aws_sns_topic.cloudtrail.name
  tags                          = local.tags

  event_selector {
    read_write_type           = "All"
    include_management_events = true

    data_resource {
      type = "AWS::S3::Object"
      values = [
        "${aws_s3_bucket.backups.arn}/",
        "${aws_s3_bucket.release_cache.arn}/",
      ]
    }
  }

  depends_on = [aws_s3_bucket_policy.bucket_transport]
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/kortix/${var.name}/cloudtrail"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}

data "aws_iam_policy_document" "cloudtrail_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail" {
  name                 = "${var.name}-cloudtrail"
  assume_role_policy   = data.aws_iam_policy_document.cloudtrail_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "cloudtrail" {
  name = "${var.name}-cloudtrail"
  role = aws_iam_role.cloudtrail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
    }]
  })
}

resource "aws_sns_topic" "cloudtrail" {
  name              = "${var.name}-cloudtrail"
  kms_master_key_id = aws_kms_key.data.arn
  tags              = local.tags
}

data "aws_iam_policy_document" "cloudtrail_topic" {
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.cloudtrail.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:cloudtrail:${local.region}:${var.expected_account_id}:trail/${var.name}"]
    }
  }
}

resource "aws_sns_topic_policy" "cloudtrail" {
  arn    = aws_sns_topic.cloudtrail.arn
  policy = data.aws_iam_policy_document.cloudtrail_topic.json
}
