data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_canonical_user_id" "current" {}
data "aws_cloudfront_log_delivery_canonical_user_id" "current" {}

locals {
  partition = data.aws_partition.current.partition
  tags = merge(var.tags, {
    ManagedBy = "terraform"
    System    = "kortix-enterprise-release"
  })
}

resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "publisher AWS account mismatch"
    }
  }
}

data "aws_iam_policy_document" "key_owner" {
  #checkov:skip=CKV_AWS_109:KMS key policies require Resource star and are scoped by attachment to each publisher key.
  #checkov:skip=CKV_AWS_111:The customer-account root is the recovery authority for each KMS key.
  #checkov:skip=CKV_AWS_356:KMS rejects its own ARN in a key policy; Resource star is the documented form.
  statement {
    sid       = "AccountOwnsKey"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${var.expected_account_id}:root"]
    }
  }
}

data "aws_iam_policy_document" "repository_key" {
  #checkov:skip=CKV_AWS_109:KMS key policies require Resource star and this document is attached only to the repository key.
  #checkov:skip=CKV_AWS_111:Account root is the recovery authority; CloudFront receives decrypt-only access for this account's distributions.
  #checkov:skip=CKV_AWS_356:KMS key policy Resource must be star.
  statement {
    sid       = "AccountOwnsKey"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${var.expected_account_id}:root"]
    }
  }
  statement {
    sid       = "CloudFrontDecryptRepository"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [var.expected_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "AWS:SourceArn"
      values   = ["arn:${local.partition}:cloudfront::${var.expected_account_id}:distribution/*"]
    }
  }
}

resource "aws_kms_key" "repository" {
  description             = "Kortix enterprise TUF repository encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.repository_key.json
  tags                    = local.tags
}

resource "aws_kms_alias" "repository" {
  name          = "alias/${var.name}-repository"
  target_key_id = aws_kms_key.repository.key_id
}

resource "aws_s3_bucket" "repository" {
  #checkov:skip=CKV_AWS_144:Release publication is not a runtime dependency; object lock, versioning, CloudFront cache, and hourly customer retry provide the required failure behavior without a second mutable origin.
  bucket              = var.repository_bucket_name
  force_destroy       = false
  object_lock_enabled = true
  tags                = local.tags
}

resource "aws_s3_bucket_public_access_block" "repository" {
  bucket                  = aws_s3_bucket.repository.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "repository" {
  bucket = aws_s3_bucket.repository.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "repository" {
  bucket = aws_s3_bucket.repository.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "repository" {
  bucket = aws_s3_bucket.repository.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.repository.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "repository" {
  bucket = aws_s3_bucket.repository.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 365
    }
  }
  depends_on = [aws_s3_bucket_versioning.repository]
}

resource "aws_s3_bucket_lifecycle_configuration" "repository" {
  bucket = aws_s3_bucket.repository.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }

  depends_on = [aws_s3_bucket_versioning.repository]
}

resource "aws_s3_bucket_notification" "repository" {
  bucket      = aws_s3_bucket.repository.id
  eventbridge = true
}

resource "aws_s3_bucket" "access_logs" {
  #checkov:skip=CKV_AWS_18:This is the terminal access-log destination; logging it to itself would recurse.
  #checkov:skip=CKV_AWS_144:Release access logs are an audit aid, while the signed repository itself is the recoverable service boundary.
  #checkov:skip=CKV2_AWS_62:Notifications on the signed repository are authoritative; per-request log object notifications would duplicate WAF and CloudFront metrics.
  #checkov:skip=CKV2_AWS_65:CloudFront legacy standard logging requires ACLs on its destination bucket; public ACLs remain blocked.
  #checkov:skip=CKV_AWS_145:CloudFront legacy standard logging supports SSE-S3, not SSE-KMS, on its destination bucket.
  bucket              = "${var.repository_bucket_name}-access-logs"
  force_destroy       = false
  object_lock_enabled = true
  tags                = local.tags
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "access_logs" {
  #checkov:skip=CKV2_AWS_65:CloudFront legacy standard logging requires an ACL-enabled BucketOwnerPreferred destination; all public ACLs remain blocked.
  bucket = aws_s3_bucket.access_logs.id
  rule { object_ownership = "BucketOwnerPreferred" }
}

resource "aws_s3_bucket_versioning" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_acl" "access_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.access_logs]
  bucket     = aws_s3_bucket.access_logs.id

  access_control_policy {
    owner {
      id = data.aws_canonical_user_id.current.id
    }
    grant {
      grantee {
        id   = data.aws_canonical_user_id.current.id
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }
    grant {
      grantee {
        id   = data.aws_cloudfront_log_delivery_canonical_user_id.current.id
        type = "CanonicalUser"
      }
      permission = "FULL_CONTROL"
    }
    grant {
      grantee {
        type = "Group"
        uri  = "http://acs.amazonaws.com/groups/s3/LogDelivery"
      }
      permission = "READ_ACP"
    }
    grant {
      grantee {
        type = "Group"
        uri  = "http://acs.amazonaws.com/groups/s3/LogDelivery"
      }
      permission = "WRITE"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  #checkov:skip=CKV_AWS_145:Legacy CloudFront standard logging supports SSE-S3, not SSE-KMS, on its ACL-enabled destination bucket.
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = 400
    }
  }
  depends_on = [aws_s3_bucket_versioning.access_logs]
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    id     = "access-log-retention"
    status = "Enabled"
    filter {}
    expiration { days = 400 }
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
  depends_on = [aws_s3_bucket_versioning.access_logs]
}

data "aws_iam_policy_document" "access_logs" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.access_logs.arn, "${aws_s3_bucket.access_logs.arn}/*"]
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

resource "aws_s3_bucket_policy" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  policy = data.aws_iam_policy_document.access_logs.json
}

resource "aws_s3_bucket_logging" "repository" {
  bucket        = aws_s3_bucket.repository.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "s3/repository/"

  depends_on = [aws_s3_bucket_acl.access_logs]
}

resource "aws_cloudfront_origin_access_control" "repository" {
  name                              = var.name
  description                       = "Private access to the authenticated enterprise release repository"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "repository" {
  name        = "${var.name}-authenticated-metadata"
  comment     = "Short cache for mutable TUF timestamp metadata; immutable targets retain origin validation"
  default_ttl = 60
  max_ttl     = 300
  min_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

resource "aws_cloudfront_response_headers_policy" "repository" {
  name = "${var.name}-security"
  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }
}

resource "aws_wafv2_web_acl" "repository" {
  provider    = aws.global
  name        = "${var.name}-cloudfront"
  description = "Managed threat filtering and abuse protection for signed enterprise releases"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "enterprise-release-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "enterprise-release-known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 30
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type = "IP"
        limit              = 5000
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "enterprise-release-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "enterprise-release-web-acl"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}

data "aws_iam_policy_document" "global_logs_key" {
  #checkov:skip=CKV_AWS_109:KMS key policies require Resource star; the account root is recovery authority only for this key.
  #checkov:skip=CKV_AWS_111:CloudWatch Logs is constrained by service principal and exact encryption-context log-group ARN.
  #checkov:skip=CKV_AWS_356:KMS rejects its own ARN in its key policy; Resource star is the documented key-policy form.
  statement {
    sid       = "AccountOwnsKey"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${var.expected_account_id}:root"]
    }
  }

  statement {
    sid = "CloudWatchLogsEncryption"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.us-east-1.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:us-east-1:${var.expected_account_id}:log-group:aws-waf-logs-${var.name}*"]
    }
  }
}

resource "aws_kms_key" "global_logs" {
  provider                = aws.global
  description             = "Kortix enterprise release WAF log encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.global_logs_key.json
  tags                    = local.tags
}

resource "aws_cloudwatch_log_group" "waf" {
  provider          = aws.global
  name              = "aws-waf-logs-${var.name}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.global_logs.arn
  tags              = local.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "repository" {
  provider                = aws.global
  resource_arn            = aws_wafv2_web_acl.repository.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
}

resource "aws_cloudfront_distribution" "repository" {
  #checkov:skip=CKV_AWS_310:The repository is a release input, not a runtime dependency; customers cache metadata and retry hourly while object-lock protects the single source.
  #checkov:skip=CKV_AWS_305:TUF clients request explicit metadata and target paths; a default root document has no valid repository meaning.
  #checkov:skip=CKV_AWS_374:Enterprise customers are global, so geographic blocking would make the release channel incorrect by design.
  #checkov:skip=CKV2_AWS_47:AWSManagedRulesKnownBadInputsRuleSet above includes Log4JRCE; Checkov does not connect the aliased us-east-1 WAF graph.
  #checkov:skip=CKV_AWS_144:Cross-region replication is tracked separately from the CloudFront distribution and does not affect runtime availability.
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = "PriceClass_100"
  comment         = "Signed Kortix enterprise stable release repository"
  web_acl_id      = aws_wafv2_web_acl.repository.arn
  aliases         = [var.repository_domain]

  logging_config {
    bucket          = aws_s3_bucket.access_logs.bucket_domain_name
    include_cookies = false
    prefix          = "cloudfront/"
  }

  origin {
    domain_name              = aws_s3_bucket.repository.bucket_regional_domain_name
    origin_id                = "enterprise-release-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.repository.id
  }

  default_cache_behavior {
    target_origin_id           = "enterprise-release-s3"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.repository.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.repository.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = var.repository_certificate_arn
    minimum_protocol_version = "TLSv1.2_2021"
    ssl_support_method       = "sni-only"
  }

  tags = local.tags
}

data "aws_iam_policy_document" "repository" {
  statement {
    sid       = "CloudFrontReadOnly"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.repository.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.repository.arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.repository.arn, "${aws_s3_bucket.repository.arn}/*"]
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

resource "aws_s3_bucket_policy" "repository" {
  bucket = aws_s3_bucket.repository.id
  policy = data.aws_iam_policy_document.repository.json
}

resource "aws_kms_key" "root" {
  count                    = 2
  description              = "Kortix enterprise TUF offline root signer ${count.index + 1}"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_3072"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.key_owner.json
  tags                     = merge(local.tags, { TufRole = "root", Automated = "false" })
}

resource "aws_kms_alias" "root" {
  count         = 2
  name          = "alias/${var.name}-tuf-root-${count.index + 1}"
  target_key_id = aws_kms_key.root[count.index].key_id
}

resource "aws_kms_key" "online" {
  for_each                 = toset(["targets", "snapshot", "timestamp"])
  description              = "Kortix enterprise TUF ${each.key} signer"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_3072"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.key_owner.json
  tags                     = merge(local.tags, { TufRole = each.key, Automated = "true" })
}

resource "aws_kms_alias" "online" {
  for_each      = aws_kms_key.online
  name          = "alias/${var.name}-tuf-${each.key}"
  target_key_id = each.value.key_id
}

resource "aws_kms_key" "cosign" {
  description              = "Kortix enterprise OCI artifact signer"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "RSA_3072"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.key_owner.json
  tags                     = merge(local.tags, { SigningRole = "cosign", Automated = "true" })
}

resource "aws_kms_alias" "cosign" {
  name          = "alias/${var.name}-cosign"
  target_key_id = aws_kms_key.cosign.key_id
}
