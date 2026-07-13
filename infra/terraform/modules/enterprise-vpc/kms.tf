# KMS key policies are scoped to the key by attachment; AWS requires Resource
# "*" in the policy document itself.
data "aws_iam_policy_document" "data_key" {
  #checkov:skip=CKV_AWS_109:This is a KMS key policy with a single customer-account root and constrained AWS service principals, not an identity policy.
  #checkov:skip=CKV_AWS_111:KMS key policy Resource must be star; principal and encryption-context conditions provide the boundary.
  #checkov:skip=CKV_AWS_356:KMS rejects its own key ARN in a key policy; Resource star is the documented form.
  statement {
    sid       = "AccountOwnsKey"
    effect    = "Allow"
    actions   = local.kms_owner_actions
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${var.expected_account_id}:root"]
    }
  }

  statement {
    sid = "SnsEncryption"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.expected_account_id]
    }
  }

  statement {
    sid = "CloudTrailEncryption"
    actions = [
      "kms:DescribeKey",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]
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

  statement {
    sid = "CloudWatchLogsEncryption"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${local.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${local.partition}:logs:${local.region}:${var.expected_account_id}:log-group:/kortix/${var.name}/*"]
    }
  }
}

resource "aws_kms_key" "data" {
  description             = "Customer-owned encryption key for ${var.name} data"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  multi_region            = false
  policy                  = data.aws_iam_policy_document.data_key.json
  tags                    = local.tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "secrets" {
  description             = "Customer-owned encryption key for ${var.name} secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  multi_region            = false
  policy                  = data.aws_iam_policy_document.secrets_key.json
  tags                    = local.tags
}

data "aws_iam_policy_document" "secrets_key" {
  #checkov:skip=CKV_AWS_109:Customer-account root ownership is the recovery path for this KMS key policy.
  #checkov:skip=CKV_AWS_111:KMS key policy Resource must be star and is scoped by attachment to this key.
  #checkov:skip=CKV_AWS_356:KMS rejects its own key ARN in a key policy; Resource star is the documented form.
  statement {
    sid       = "AccountOwnsKey"
    effect    = "Allow"
    actions   = local.kms_owner_actions
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${var.expected_account_id}:root"]
    }
  }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_secretsmanager_secret" "runtime" {
  #checkov:skip=CKV2_AWS_57:Runtime credentials require coordinated zero-downtime rotation across Supabase and EKS; the signed updater performs that tested workflow rather than an uncoordinated generic Lambda rotation.
  name                    = "${var.name}/runtime"
  description             = "Tenant-owned Kortix and Supabase runtime environment"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30
  tags                    = local.tags
}

resource "aws_secretsmanager_secret" "updater" {
  #checkov:skip=CKV2_AWS_57:Updater integration values rotate through the signed release workflow because no generic rotation Lambda can verify downstream activation safely.
  name                    = "${var.name}/updater"
  description             = "Tenant-owned updater integration values; no Kortix AWS credentials"
  kms_key_id              = aws_kms_key.secrets.arn
  recovery_window_in_days = 30
  tags                    = local.tags
}
