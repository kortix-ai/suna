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
  id = "arn:aws:cloudtrail:us-east-1:935064898258:trail/management-events"
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
  to = aws_guardduty_detector.aps1
  id = "48cf47392817ef3fdf6841bf156b8e97"
}
import {
  to = aws_guardduty_detector.eun1
  id = "80cf47392cd5a5f04acf3d8241e1d070"
}
import {
  to = aws_guardduty_detector.euw3
  id = "aecf47392fbccdeea9d8e7a675d730cb"
}
import {
  to = aws_guardduty_detector.euw2
  id = "f2cf473932e9e3135c033f395a4a8e09"
}
import {
  to = aws_guardduty_detector.euw1
  id = "c8cf473935f2098f92cd348ce457a876"
}
import {
  to = aws_guardduty_detector.apne3
  id = "c6cf47393b49f00d86993fa2f8d935c4"
}
import {
  to = aws_guardduty_detector.apne2
  id = "96cf47394043a5e0cac7e695bac98307"
}
import {
  to = aws_guardduty_detector.apne1
  id = "96cf473945687ac9917af8e2f67d20bb"
}
import {
  to = aws_guardduty_detector.cac1
  id = "8ccf4739494abaaecd7c1039c4e0308b"
}
import {
  to = aws_guardduty_detector.sae1
  id = "e6cf47394de6eb5b4572e8f969c837c0"
}
import {
  to = aws_guardduty_detector.apse1
  id = "90cf473952467ffb9f2c1d900106b5d3"
}
import {
  to = aws_guardduty_detector.apse2
  id = "e8cf4739581ddd4d866fd1034e98e406"
}
import {
  to = aws_guardduty_detector.euc1
  id = "16cf47395ad7d2a0f7de56805fb76881"
}
import {
  to = aws_guardduty_detector.use2
  id = "5ccf473961e8fd4cf9a328fb8b5f0670"
}
import {
  to = aws_guardduty_detector.usw1
  id = "b8cf473965d80b5fd3748b4c8fd8111e"
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
