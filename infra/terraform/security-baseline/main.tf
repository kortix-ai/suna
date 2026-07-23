# ════════════════════════════════════════════════════════════════════════════
# IAM account password policy           — Drata DCF-68 (min length), DCF-350 (reuse)
# ════════════════════════════════════════════════════════════════════════════
resource "aws_iam_account_password_policy" "this" {
  minimum_password_length        = 14
  require_symbols                = true
  require_numbers                = true
  require_uppercase_characters   = true
  require_lowercase_characters   = true
  allow_users_to_change_password = true
  max_password_age               = 90
  password_reuse_prevention      = 24
}

# ════════════════════════════════════════════════════════════════════════════
# CloudTrail: KMS encryption + log-file validation + S3 data events
#   — Drata DCF-54 (encrypted), DCF-478 (log validation), DCF-406 (object logging)
# ════════════════════════════════════════════════════════════════════════════
resource "aws_kms_key" "cloudtrail" {
  provider                = aws.use1
  description             = "CloudTrail log encryption (SOC2 DCF-54)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "cloudtrail-cmk-policy"
    Statement = [
      { Sid    = "EnableRoot", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${local.account_id}:root" },
        Action = ["kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"],
      Resource = "*" },
      { Sid = "AllowCloudTrailEncrypt", Effect = "Allow", Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "kms:GenerateDataKey*", Resource = "*",
      Condition = { StringLike = { "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${local.account_id}:trail/*" } } },
      { Sid = "AllowCloudTrailDescribe", Effect = "Allow", Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "kms:DescribeKey", Resource = "*" },
      { Sid = "AllowLogReadersDecrypt", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }, Action = ["kms:Decrypt", "kms:ReEncryptFrom"], Resource = "*",
      Condition = { StringEquals = { "kms:CallerAccount" = local.account_id }, StringLike = { "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${local.account_id}:trail/*" } } },
      # Lets the CloudWatch Logs group the trail delivers to (below) also be
      # encrypted with this CMK, instead of shipping it unencrypted (Trivy
      # AWS-0017 / Checkov CKV_AWS_158).
      { Sid    = "AllowCloudWatchLogsEncrypt", Effect = "Allow", Principal = { Service = "logs.us-east-1.amazonaws.com" },
        Action = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*",
      Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:us-east-1:${local.account_id}:log-group:*" } } },
      { Sid    = "AllowSNSEncryption", Effect = "Allow", Principal = { Service = "sns.amazonaws.com" },
        Action = ["kms:Decrypt", "kms:GenerateDataKey*"], Resource = "*",
      Condition = { StringEquals = { "kms:CallerAccount" = local.account_id } } }
    ]
  })
  tags = {
    ManagedBy  = "terraform"
    Name       = "cloudtrail"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_kms_alias" "cloudtrail" {
  provider      = aws.use1
  name          = "alias/cloudtrail"
  target_key_id = aws_kms_key.cloudtrail.key_id
}

resource "aws_cloudtrail" "management_events" {
  provider                      = aws.use1
  name                          = "management-events"
  s3_bucket_name                = "aws-cloudtrail-logs-${local.account_id}-338918c1"
  sns_topic_name                = aws_sns_topic.cloudtrail.name
  kms_key_id                    = aws_kms_key.cloudtrail.arn
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  # Real-time CloudWatch Logs delivery alongside the durable S3 trail
  # (Trivy AWS-0162 / avd.aquasec.com/misconfig/aws-0162). S3 stays the
  # long-term/durable copy; this just adds the searchable, real-time
  # analysis path CloudTrail's own S3 delivery doesn't provide.
  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_cloudwatch_logs.arn

  # S3 object-level read+write data events (DCF-406)
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::S3::Object"
      values = ["arn:aws:s3"]
    }
  }
  tags = {
    ManagedBy  = "terraform"
    Name       = "management-events"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_sns_topic" "cloudtrail" {
  provider          = aws.use1
  name              = "kortix-cloudtrail-events"
  kms_master_key_id = aws_kms_key.cloudtrail.arn
  signature_version = 2
  tracing_config    = "Active"
  tags              = local.tags
}

data "aws_iam_policy_document" "cloudtrail_sns" {
  statement {
    sid = "AccountAdministration"
    actions = [
      "SNS:AddPermission",
      "SNS:DeleteTopic",
      "SNS:GetTopicAttributes",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
      "SNS:RemovePermission",
      "SNS:SetTopicAttributes",
      "SNS:Subscribe",
    ]
    resources = [aws_sns_topic.cloudtrail.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowCloudTrailPublish"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.cloudtrail.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:us-east-1:${local.account_id}:trail/management-events"]
    }
  }
}

resource "aws_sns_topic_policy" "cloudtrail" {
  provider = aws.use1
  arn      = aws_sns_topic.cloudtrail.arn
  policy   = data.aws_iam_policy_document.cloudtrail_sns.json
}

# CloudWatch Logs destination + delivery role for the trail above (AWS-0162).
# Log group lives in us-east-1 alongside the trail's home region — CloudTrail
# requires the log group and delivery role to be in the same region as the
# trail itself.
resource "aws_cloudwatch_log_group" "cloudtrail" {
  provider          = aws.use1
  name              = "/aws/cloudtrail/management-events"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.cloudtrail.arn
  tags = {
    ManagedBy  = "terraform"
    Name       = "cloudtrail"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_iam_role" "cloudtrail_cloudwatch_logs" {
  name               = "cloudtrail-cloudwatch-logs-role"
  description        = "CloudTrail -> CloudWatch Logs delivery (SOC2 DCF-406, AWS-0162)"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags = {
    ManagedBy  = "terraform"
    Name       = "cloudtrail-cloudwatch-logs-role"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_iam_role_policy" "cloudtrail_cloudwatch_logs" {
  name = "cloudtrail-cloudwatch-logs-delivery"
  role = aws_iam_role.cloudtrail_cloudwatch_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
    }]
  })
}

# ════════════════════════════════════════════════════════════════════════════
# GuardDuty — Drata DCF-87 (threat detection). GuardDuty is regional, so every
# opted-in commercial region is managed even when it currently has no workload.
# ════════════════════════════════════════════════════════════════════════════
resource "aws_guardduty_detector" "usw2" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "use1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.use1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "aps1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.aps1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "eun1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.eun1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "euw3" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.euw3
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "euw2" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.euw2
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "euw1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.euw1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "apne3" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.apne3
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "apne2" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.apne2
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "apne1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.apne1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "cac1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.cac1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "sae1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.sae1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "apse1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.apse1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "apse2" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.apse2
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "euc1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.euc1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "use2" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.use2
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "usw1" {
  #checkov:skip=CKV2_AWS_3:Kortix is a member of a reseller-owned CONSOLIDATED_BILLING organization and cannot configure organization-wide GuardDuty administration; this detector enforces the account-level regional control.
  provider                     = aws.usw1
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
  tags                         = local.tags
}

# EBS default encryption — Drata DCF-54. This account-level regional default is
# enforced everywhere, including empty regions, so future volumes are encrypted
# before a workload can make that region part of the compliance scope.
resource "aws_ebs_encryption_by_default" "usw2" {
  enabled = true
}

resource "aws_ebs_encryption_by_default" "use1" {
  provider = aws.use1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "aps1" {
  provider = aws.aps1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "eun1" {
  provider = aws.eun1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "euw3" {
  provider = aws.euw3
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "euw2" {
  provider = aws.euw2
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "euw1" {
  provider = aws.euw1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "apne3" {
  provider = aws.apne3
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "apne2" {
  provider = aws.apne2
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "apne1" {
  provider = aws.apne1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "cac1" {
  provider = aws.cac1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "sae1" {
  provider = aws.sae1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "apse1" {
  provider = aws.apse1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "apse2" {
  provider = aws.apse2
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "euc1" {
  provider = aws.euc1
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "use2" {
  provider = aws.use2
  enabled  = true
}

resource "aws_ebs_encryption_by_default" "usw1" {
  provider = aws.usw1
  enabled  = true
}

# ════════════════════════════════════════════════════════════════════════════
# S3 account-level public access block (defense in depth for DCF-55/78/406)
# Per-bucket versioning / TLS-deny / access-logging live with each bucket's
# owner; the account block backstops all of them.
# ════════════════════════════════════════════════════════════════════════════
resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ════════════════════════════════════════════════════════════════════════════
# AWS Backup — Drata DCF-99 (daily backups monitored)
# ════════════════════════════════════════════════════════════════════════════
resource "aws_iam_role" "backup" {
  name               = "AWSBackupDefaultServiceRole"
  description        = "AWS Backup service role (SOC2 DCF-99)"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags = {
    ManagedBy  = "terraform"
    Name       = "AWSBackupDefaultServiceRole"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}
resource "aws_iam_role_policy_attachment" "backup_backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}
resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}
resource "aws_kms_key" "backup" {
  description             = "AWS Backup vault encryption (SOC2 DCF-99)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableAccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action = [
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
        Resource = "*"
      },
      {
        Sid       = "AllowAWSBackup"
        Effect    = "Allow"
        Principal = { Service = "backup.amazonaws.com" }
        Action = [
          "kms:CreateGrant",
          "kms:Decrypt",
          "kms:DescribeKey",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyWithoutPlaintext",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
        ]
        Resource = "*"
        Condition = {
          Bool = { "kms:GrantIsForAWSResource" = "true" }
        }
      },
    ]
  })
  tags = local.tags
}
resource "aws_kms_alias" "backup" {
  name          = "alias/kortix-backup"
  target_key_id = aws_kms_key.backup.key_id
}
resource "aws_backup_vault" "encrypted" {
  name        = "kortix-backup-vault-cmk"
  kms_key_arn = aws_kms_key.backup.arn
  tags        = local.tags

  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_backup_plan" "daily" {
  name = "kortix-daily"
  rule {
    rule_name         = "daily-35d"
    target_vault_name = aws_backup_vault.encrypted.name
    schedule          = "cron(0 5 * * ? *)"
    start_window      = 60
    completion_window = 180
    lifecycle { delete_after = 35 }
  }
  tags = local.tags
}
resource "aws_backup_selection" "daily" {
  name         = "kortix-daily-sel"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = ["arn:aws:dynamodb:us-west-2:${local.account_id}:table/kortix-terraform-locks"]
  selection_tag {
    type  = "STRINGEQUALS"
    key   = "backup"
    value = "daily"
  }
}

# ════════════════════════════════════════════════════════════════════════════
# VPC Flow Logs delivery role — Drata DCF-406. Flow logs themselves are created
# per-VPC (CLI / network module) against this role + the /vpc/flowlogs group.
# ════════════════════════════════════════════════════════════════════════════
resource "aws_iam_role" "flow_logs" {
  name               = "vpc-flow-logs-role"
  description        = "VPC Flow Logs delivery (SOC2 DCF-406)"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "vpc-flow-logs.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  tags = {
    ManagedBy  = "terraform"
    Name       = "vpc-flow-logs-role"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}
resource "aws_iam_role_policy" "flow_logs" {
  name   = "flow-logs-delivery"
  role   = aws_iam_role.flow_logs.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"], Resource = ["arn:aws:logs:*:${local.account_id}:log-group:/vpc/flowlogs", "arn:aws:logs:*:${local.account_id}:log-group:/vpc/flowlogs:*", "arn:aws:logs:*:${local.account_id}:log-group:/vpc/flowlogs:*:log-stream:*"] }] })
}
resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/vpc/flowlogs"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.cloudwatch_logs.arn
  tags              = local.tags
}

# CMK for CloudWatch Logs in the default (us-west-2) region — CloudWatch log
# groups are encrypted at rest by AWS either way, but a dedicated CMK gives us
# key-rotation + access control (Trivy AWS-0017 / avd.aquasec.com/misconfig/aws-0017).
resource "aws_kms_key" "cloudwatch_logs" {
  description             = "CloudWatch Logs encryption, us-west-2 (SOC2 DCF-54)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "cloudwatch-logs-cmk-policy"
    Statement = [
      { Sid    = "EnableRoot", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${local.account_id}:root" },
        Action = ["kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*", "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"],
      Resource = "*" },
      { Sid    = "AllowCloudWatchLogsEncrypt", Effect = "Allow", Principal = { Service = "logs.us-west-2.amazonaws.com" },
        Action = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"], Resource = "*",
      Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:us-west-2:${local.account_id}:log-group:*" } } }
    ]
  })
  tags = {
    ManagedBy  = "terraform"
    Name       = "cloudwatch-logs"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_kms_alias" "cloudwatch_logs" {
  name          = "alias/cloudwatch-logs"
  target_key_id = aws_kms_key.cloudwatch_logs.key_id
}
