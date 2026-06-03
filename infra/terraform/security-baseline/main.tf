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
      { Sid = "EnableRoot", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }, Action = "kms:*", Resource = "*" },
      { Sid = "AllowCloudTrailEncrypt", Effect = "Allow", Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "kms:GenerateDataKey*", Resource = "*",
      Condition = { StringLike = { "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${local.account_id}:trail/*" } } },
      { Sid = "AllowCloudTrailDescribe", Effect = "Allow", Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "kms:DescribeKey", Resource = "*" },
      { Sid = "AllowLogReadersDecrypt", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }, Action = ["kms:Decrypt", "kms:ReEncryptFrom"], Resource = "*",
      Condition = { StringEquals = { "kms:CallerAccount" = local.account_id }, StringLike = { "kms:EncryptionContext:aws:cloudtrail:arn" = "arn:aws:cloudtrail:*:${local.account_id}:trail/*" } } }
    ]
  })
  tags = local.tags
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
  kms_key_id                    = aws_kms_key.cloudtrail.arn
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  # S3 object-level read+write data events (DCF-406)
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::S3::Object"
      values = ["arn:aws:s3"]
    }
  }
  tags = local.tags
}

# ════════════════════════════════════════════════════════════════════════════
# GuardDuty — Drata DCF-87 (threat detection). Enabled in ALL 17 regions via CLI;
# the two active regions are codified here. Add provider aliases for the rest if
# you want full Terraform coverage.
# ════════════════════════════════════════════════════════════════════════════
resource "aws_guardduty_detector" "usw2" {
  enable                       = true
  finding_publishing_frequency = "SIX_HOURS"
  tags                         = local.tags
}

resource "aws_guardduty_detector" "use1" {
  provider                     = aws.use1
  enable                       = true
  finding_publishing_frequency = "SIX_HOURS"
  tags                         = local.tags
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
  tags               = local.tags
}
resource "aws_iam_role_policy_attachment" "backup_backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}
resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}
resource "aws_backup_vault" "this" {
  name = "kortix-backup-vault"
  tags = local.tags
}
resource "aws_backup_plan" "daily" {
  name = "kortix-daily"
  rule {
    rule_name         = "daily-35d"
    target_vault_name = aws_backup_vault.this.name
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
  tags               = local.tags
}
resource "aws_iam_role_policy" "flow_logs" {
  name   = "flow-logs-delivery"
  role   = aws_iam_role.flow_logs.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"], Resource = "*" }] })
}
resource "aws_cloudwatch_log_group" "flow_logs" {
  name              = "/vpc/flowlogs"
  retention_in_days = 90
  tags              = local.tags
}
