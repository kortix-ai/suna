data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  state_log_bucket_name = "${substr(var.state_bucket_name, 0, 49)}-${substr(sha256(var.state_bucket_name), 0, 8)}-logs"
  kms_owner_actions = [
    "kms:CancelKeyDeletion",
    "kms:CreateAlias",
    "kms:CreateGrant",
    "kms:CreateKey",
    "kms:Decrypt",
    "kms:DeleteAlias",
    "kms:DeleteImportedKeyMaterial",
    "kms:DescribeKey",
    "kms:DisableKey",
    "kms:DisableKeyRotation",
    "kms:EnableKey",
    "kms:EnableKeyRotation",
    "kms:Encrypt",
    "kms:GenerateDataKey*",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:GetParametersForImport",
    "kms:GetPublicKey",
    "kms:ImportKeyMaterial",
    "kms:ListAliases",
    "kms:ListGrants",
    "kms:ListKeyPolicies",
    "kms:ListKeys",
    "kms:ListResourceTags",
    "kms:ListRetirableGrants",
    "kms:PutKeyPolicy",
    "kms:ReEncrypt*",
    "kms:ReplicateKey",
    "kms:RetireGrant",
    "kms:RevokeGrant",
    "kms:ScheduleKeyDeletion",
    "kms:Sign",
    "kms:SynchronizeMultiRegionKey",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:UpdateAlias",
    "kms:UpdateKeyDescription",
    "kms:UpdatePrimaryRegion",
    "kms:Verify",
  ]
  tags = merge(var.tags, {
    ManagedBy      = "terraform"
    Platform       = "kortix-enterprise-state"
    KortixInstance = var.name
    DataBoundary   = "customer-account"
  })
}

# This boundary is part of the customer-owned trust plane. Runtime roles may
# perform their narrow identity-policy actions, but can never mutate IAM/KMS
# trust, network boundaries, release-event trust, or storage access policies.
data "aws_iam_policy_document" "role_boundary" {
  #checkov:skip=CKV_AWS_107:This boundary grants nothing alone; effective permissions are the intersection with narrow identity policies.
  #checkov:skip=CKV_AWS_108:This boundary grants nothing alone; storage/network trust mutation is explicitly denied and identity policies scope data access.
  #checkov:skip=CKV_AWS_109:This boundary grants nothing alone and explicitly denies IAM, KMS, network, storage-policy, and event-trust mutation.
  #checkov:skip=CKV_AWS_110:Privilege-escalation actions are explicitly denied by this customer-owned boundary.
  #checkov:skip=CKV_AWS_111:These are service-scoped maxima in a permissions boundary, not identity grants; every attached role still requires a narrow identity policy.
  #checkov:skip=CKV_AWS_356:Reusable boundary resources cannot be known in advance and the boundary grants nothing by itself.
  statement {
    sid    = "BoundRuntimeIdentityPolicies"
    effect = "Allow"
    actions = [
      "acm:*",
      "autoscaling:*",
      "backup:*",
      "cloudtrail:*",
      "cloudwatch:*",
      "codebuild:*",
      "dynamodb:*",
      "ec2:*",
      "ecr:*",
      "eks:*",
      "elasticloadbalancing:*",
      "events:*",
      "iam:Get*",
      "iam:List*",
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:List*",
      "kms:ReEncrypt*",
      "kms:RetireGrant",
      "kms:RevokeGrant",
      "logs:*",
      "s3:*",
      "secretsmanager:*",
      "sns:*",
      "ssm:*",
      "states:*",
      "sts:AssumeRole",
      "sts:AssumeRoleWithWebIdentity",
      "sts:GetCallerIdentity",
      "tag:*",
      "xray:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DenyIdentityAndKeyEscalation"
    effect = "Deny"
    actions = [
      "iam:Add*",
      "iam:Attach*",
      "iam:Create*",
      "iam:Delete*",
      "iam:Detach*",
      "iam:PassRole",
      "iam:Put*",
      "iam:Remove*",
      "iam:SetDefaultPolicyVersion",
      "iam:Update*",
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:CreateCustomKeyStore",
      "kms:CreateKey",
      "kms:Delete*",
      "kms:Disable*",
      "kms:Enable*",
      "kms:ImportKeyMaterial",
      "kms:Put*",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:Update*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DenyNetworkAndReleaseTrustMutation"
    effect = "Deny"
    actions = [
      "ec2:AssociateRouteTable",
      "ec2:AuthorizeSecurityGroup*",
      "ec2:CreateInternetGateway",
      "ec2:CreateNatGateway",
      "ec2:CreateNetworkAcl*",
      "ec2:CreateRoute*",
      "ec2:CreateSecurityGroup",
      "ec2:CreateSubnet",
      "ec2:CreateVpc*",
      "ec2:DeleteInternetGateway",
      "ec2:DeleteNatGateway",
      "ec2:DeleteNetworkAcl*",
      "ec2:DeleteRoute*",
      "ec2:DeleteSecurityGroup",
      "ec2:DeleteSubnet",
      "ec2:DeleteVpc*",
      "ec2:DisassociateRouteTable",
      "ec2:ModifyNetworkInterfaceAttribute",
      "ec2:ModifySubnetAttribute",
      "ec2:ModifyVpc*",
      "ec2:ReplaceNetworkAcl*",
      "ec2:ReplaceRoute*",
      "ec2:RevokeSecurityGroup*",
      "eks:AssociateAccessPolicy",
      "eks:CreateAccessEntry",
      "eks:DeleteAccessEntry",
      "eks:DisassociateAccessPolicy",
      "eks:UpdateAccessEntry",
      "eks:UpdateClusterConfig",
      "events:PutPermission",
      "events:RemovePermission",
      "s3:DeleteBucketPolicy",
      "s3:PutAccountPublicAccessBlock",
      "s3:PutBucketAcl",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "secretsmanager:DeleteResourcePolicy",
      "secretsmanager:PutResourcePolicy",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "role_boundary" {
  name        = "${var.name}-workload-boundary"
  description = "Maximum permissions for Kortix customer-owned workload and updater roles"
  policy      = data.aws_iam_policy_document.role_boundary.json
  tags        = local.tags

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [terraform_data.account_guard]
}

resource "terraform_data" "account_guard" {
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "AWS account mismatch: refusing to bootstrap state outside account ${var.expected_account_id}."
    }
  }
}

data "aws_iam_policy_document" "state_key" {
  #checkov:skip=CKV_AWS_109:This is a KMS key policy granting the customer-account root its mandatory recovery ownership path.
  #checkov:skip=CKV_AWS_111:KMS key policy Resource must be star and is scoped by attachment to this key.
  #checkov:skip=CKV_AWS_356:KMS rejects its own key ARN in a key policy; Resource star is the documented form.
  statement {
    actions   = local.kms_owner_actions
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${var.expected_account_id}:root"]
    }
  }
}

resource "aws_kms_key" "state" {
  description             = "Customer-owned Terraform state key for ${var.name}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.state_key.json
  tags                    = local.tags
}

resource "aws_kms_alias" "state" {
  name          = "alias/${var.name}-terraform-state"
  target_key_id = aws_kms_key.state.key_id
}

resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV2_AWS_62:State mutations are audited through dedicated access logs; event notifications are intentionally not coupled to an external destination during trust-plane bootstrap.
  #checkov:skip=CKV_AWS_144:Enterprise state remains in the customer-selected region for data residency; versioning and a separate access-log bucket provide local recovery evidence.
  bucket        = var.state_bucket_name
  force_destroy = false
  tags          = local.tags

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [terraform_data.account_guard]
}

# Dedicated target avoids recursive logging and keeps state object names out of
# any shared logging plane.
resource "aws_s3_bucket" "state_logs" {
  #checkov:skip=CKV2_AWS_62:This bucket is itself the terminal server-access-log destination.
  #checkov:skip=CKV_AWS_144:Access logs remain in the customer-selected residency region.
  #checkov:skip=CKV_AWS_18:An access-log destination must not log to itself.
  #checkov:skip=CKV_AWS_145:S3 server-access-log destinations support SSE-S3; public access is blocked and the customer-account bucket is dedicated to logs.
  bucket        = local.state_log_bucket_name
  force_destroy = false
  tags          = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_versioning" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.state.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "state_logs" {
  bucket                  = aws_s3_bucket.state_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    id     = "retain-state-history"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 365 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  rule {
    id     = "retain-state-access-logs"
    status = "Enabled"
    filter {}
    expiration { days = 365 }
    noncurrent_version_expiration { noncurrent_days = 365 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
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
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json
}

data "aws_iam_policy_document" "state_logs" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state_logs.arn,
      "${aws_s3_bucket.state_logs.arn}/*",
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

  statement {
    sid       = "S3ServerAccessLogs"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.state_logs.arn}/state-access/AWSLogs/${var.expected_account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.expected_account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.state.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  policy = data.aws_iam_policy_document.state_logs.json
}

resource "aws_s3_bucket_logging" "state" {
  bucket        = aws_s3_bucket.state.id
  target_bucket = aws_s3_bucket.state_logs.id
  target_prefix = "state-access/AWSLogs/${var.expected_account_id}/"

  depends_on = [aws_s3_bucket_policy.state_logs]
}

resource "aws_dynamodb_table" "locks" {
  name         = var.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery { enabled = true }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state.arn
  }
  deletion_protection_enabled = true
  tags                        = local.tags

  lifecycle {
    prevent_destroy = true
  }
}
