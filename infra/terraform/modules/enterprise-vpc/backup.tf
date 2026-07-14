resource "aws_backup_vault" "supabase" {
  name        = "${var.name}-supabase"
  kms_key_arn = aws_kms_key.data.arn
  tags        = local.tags
}
resource "aws_backup_vault_lock_configuration" "supabase" {
  backup_vault_name   = aws_backup_vault.supabase.name
  min_retention_days  = var.backup_retention_days
  max_retention_days  = 365
  changeable_for_days = 7
}

resource "aws_backup_plan" "supabase" {
  name = "${var.name}-supabase"

  rule {
    rule_name         = "hourly-ebs-snapshot"
    target_vault_name = aws_backup_vault.supabase.name
    schedule          = "cron(0 * ? * * *)"
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = var.backup_retention_days
    }
  }

  tags = local.tags
}

data "aws_iam_policy_document" "backup_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup" {
  name                 = "${var.name}-backup"
  assume_role_policy   = data.aws_iam_policy_document.backup_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "supabase" {
  name         = "${var.name}-supabase-data"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.supabase.id
  resources    = [aws_ebs_volume.supabase_data.arn]
}
