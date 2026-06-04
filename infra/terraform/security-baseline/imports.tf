# Adopt the already-live resources (remediated via CLI on 2026-06-03) into this
# state so `terraform plan` shows an empty diff instead of trying to recreate
# them. Run `terraform plan` after `init`; the import blocks below adopt the
# singletons. For the for_each IAM groups, use the commands in README.md.
#
# After a clean (empty) plan, you can delete this file — imports are one-shot.

import {
  to = aws_iam_account_password_policy.this
  id = "935064898258"
}
import {
  to = aws_kms_key.cloudtrail
  id = "56b619f9-5dd5-4a2c-b838-ebc8a89ad1b1"
}
import {
  to = aws_kms_alias.cloudtrail
  id = "alias/cloudtrail"
}
import {
  to = aws_cloudtrail.management_events
  id = "management-events"
}
import {
  to = aws_guardduty_detector.usw2
  id = "b6cf47396a52955cbe2d06d046844da8"
}
import {
  to = aws_guardduty_detector.use1
  id = "c4cf47395e33e146a188d9a061f25c0f"
}
import {
  to = aws_s3_account_public_access_block.this
  id = "935064898258"
}
import {
  to = aws_iam_role.backup
  id = "AWSBackupDefaultServiceRole"
}
import {
  to = aws_backup_vault.this
  id = "kortix-backup-vault"
}
import {
  to = aws_backup_plan.daily
  id = "0f55c185-2a80-467e-95dd-e0d969c93f52"
}
import {
  to = aws_iam_role.flow_logs
  id = "vpc-flow-logs-role"
}
import {
  to = aws_cloudwatch_log_group.flow_logs
  id = "/vpc/flowlogs"
}
import {
  to = aws_iam_policy.cloudwatch_logs
  id = "arn:aws:iam::935064898258:policy/kortix-cloudwatch-logs-policy"
}
import {
  to = aws_iam_policy.bedrock_count_tokens
  id = "arn:aws:iam::935064898258:policy/kortix-bedrock-count-tokens"
}
