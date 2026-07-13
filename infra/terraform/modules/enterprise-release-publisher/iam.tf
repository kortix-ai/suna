data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_environment}"]
    }
  }
}

resource "aws_iam_role" "promotion" {
  name                 = "${var.name}-promotion"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "promotion" {
  statement {
    sid     = "NeverModifyOfflineRootMetadata"
    effect  = "Deny"
    actions = ["s3:DeleteObject", "s3:PutObject"]
    resources = [
      "${aws_s3_bucket.repository.arn}/metadata/root.json",
      "${aws_s3_bucket.repository.arn}/metadata/*.root.json",
    ]
  }

  statement {
    sid       = "SignOnlineMetadataAndArtifacts"
    actions   = ["kms:GetPublicKey", "kms:Sign"]
    resources = concat([for key in aws_kms_key.online : key.arn], [aws_kms_key.cosign.arn])
  }

  statement {
    sid       = "EncryptPublishedRepositoryObjects"
    actions   = ["kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.repository.arn]
  }

  statement {
    sid       = "ReadRepository"
    actions   = ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.repository.arn]
  }

  statement {
    sid = "PublishRepositoryWithoutDelete"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:PutObjectRetention",
    ]
    resources = ["${aws_s3_bucket.repository.arn}/*"]
  }

  statement {
    sid       = "InvalidateMutableTufMetadata"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.repository.arn]
  }

  dynamic "statement" {
    for_each = length(var.customer_event_bus_arns) == 0 ? [] : [1]
    content {
      sid       = "SendOptionalCustomerHints"
      actions   = ["events:PutEvents"]
      resources = var.customer_event_bus_arns
    }
  }
}

resource "aws_iam_role_policy" "promotion" {
  name   = "${var.name}-promotion"
  role   = aws_iam_role.promotion.id
  policy = data.aws_iam_policy_document.promotion.json
}

data "aws_iam_policy_document" "github_timestamp_refresh_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:environment:${var.github_refresh_environment}"]
    }
  }
}

resource "aws_iam_role" "timestamp_refresh" {
  name                 = "${var.name}-timestamp-refresh"
  assume_role_policy   = data.aws_iam_policy_document.github_timestamp_refresh_assume.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
  tags                 = merge(local.tags, { TufRole = "timestamp" })
}

data "aws_iam_policy_document" "timestamp_refresh" {
  statement {
    sid       = "SignOnlyTimestampMetadata"
    actions   = ["kms:GetPublicKey", "kms:Sign"]
    resources = [aws_kms_key.online["timestamp"].arn]
  }

  statement {
    sid       = "EncryptTimestampMetadata"
    actions   = ["kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.repository.arn]
  }

  statement {
    sid       = "ReadRepositoryLocation"
    actions   = ["s3:GetBucketLocation"]
    resources = [aws_s3_bucket.repository.arn]
  }

  statement {
    sid       = "ListRepositoryMetadata"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.repository.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["metadata", "metadata/*"]
    }
  }

  statement {
    sid       = "ReadAuthenticatedMetadata"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.repository.arn}/metadata/*"]
  }

  statement {
    sid       = "PublishOnlyTimestampMetadata"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.repository.arn}/metadata/timestamp.json"]
  }

  statement {
    sid       = "InvalidateOnlyTimestampMetadata"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.repository.arn]
  }
}

resource "aws_iam_role_policy" "timestamp_refresh" {
  name   = "${var.name}-timestamp-refresh"
  role   = aws_iam_role.timestamp_refresh.id
  policy = data.aws_iam_policy_document.timestamp_refresh.json
}
