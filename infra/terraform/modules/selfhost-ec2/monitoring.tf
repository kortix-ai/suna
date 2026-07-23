# Minimal, boring CloudWatch monitoring: an EC2 status-check alarm (no
# agent needed) plus disk/memory alarms fed by the CloudWatch agent that
# templates/user-data.sh.tftpl installs and configures on the box (see the
# "monitoring" section there). These are var-gated by var.enable_alarms
# (default true) — this is a single unmonitored box otherwise, which was
# finding #4 of the 2026-07 production-readiness audit.
#
# Also here: the two self-healing alarms (var.enable_auto_recovery /
# var.enable_auto_reboot, both default true, both independent of
# var.enable_alarms since they key off native AWS/EC2 status-check metrics,
# no agent needed) — the recovery half of "single stateful box, not a fleet"
# (see README "Scaling": no horizontal/ASG scaling, no container
# autoscaling — vertical resize + auto-recovery instead).

# ── IAM: let the box publish CloudWatch agent metrics/logs ─────────────────
resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  count      = var.enable_alarms ? 1 : 0
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ── SNS: notify on alarm ────────────────────────────────────────────────────
resource "aws_kms_key" "alarm_topic" {
  count                   = var.enable_alarms && var.alarm_sns_topic_arn == "" ? 1 : 0
  description             = "Encrypt ${local.name} alarm notifications"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action = [
          "kms:CancelKeyDeletion",
          "kms:CreateAlias",
          "kms:CreateGrant",
          "kms:Decrypt",
          "kms:DeleteAlias",
          "kms:DescribeKey",
          "kms:DisableKey",
          "kms:DisableKeyRotation",
          "kms:EnableKey",
          "kms:EnableKeyRotation",
          "kms:Encrypt",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyWithoutPlaintext",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:ListAliases",
          "kms:ListGrants",
          "kms:ListKeyPolicies",
          "kms:ListKeyRotations",
          "kms:ListResourceTags",
          "kms:ListRetirableGrants",
          "kms:PutKeyPolicy",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
          "kms:RetireGrant",
          "kms:RevokeGrant",
          "kms:RotateKeyOnDemand",
          "kms:ScheduleKeyDeletion",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:UpdateAlias",
          "kms:UpdateKeyDescription",
        ]
        Resource = "*"
      },
      {
        Sid       = "AllowSnsEncryption"
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action = [
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:GenerateDataKeyWithoutPlaintext",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
        }
      },
    ]
  })
  tags = local.tags
}

resource "aws_kms_alias" "alarm_topic" {
  count         = var.enable_alarms && var.alarm_sns_topic_arn == "" ? 1 : 0
  name          = "alias/${local.name}-alarms"
  target_key_id = aws_kms_key.alarm_topic[0].key_id
}

resource "aws_sns_topic" "alarms" {
  count             = var.enable_alarms && var.alarm_sns_topic_arn == "" ? 1 : 0
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.alarm_topic[0].arn
  tags = {
    ManagedBy      = "terraform"
    Name           = "${local.name}-alarms"
    Module         = "selfhost-ec2"
    Environment    = lookup(var.tags, "Environment", "managed")
    Project        = lookup(var.tags, "Project", "kortix")
    KortixInstance = lookup(var.tags, "KortixInstance", local.name)
  }
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.enable_alarms && var.alarm_sns_topic_arn == "" && var.alarm_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_topic_arn = var.alarm_sns_topic_arn != "" ? var.alarm_sns_topic_arn : (
    var.enable_alarms ? aws_sns_topic.alarms[0].arn : ""
  )
}

# ── EC2 status-check alarm (instance + system checks; no agent required) ───
resource "aws_cloudwatch_metric_alarm" "status_check" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${local.name}-status-check-failed"
  alarm_description   = "EC2 instance or system status check failed for ${local.name} (${aws_instance.this.id})."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    InstanceId = aws_instance.this.id
  }

  alarm_actions = [local.alarm_topic_arn]
  ok_actions    = [local.alarm_topic_arn]
  tags          = local.tags
}

# ── Disk usage (CloudWatch agent, "disk" plugin, drop_device — see
#    user-data) — one alarm each for the root volume and the data volume. ───
resource "aws_cloudwatch_metric_alarm" "disk_usage_root" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${local.name}-disk-usage-root"
  alarm_description   = "Root (\"/\") disk usage on ${local.name} (${aws_instance.this.id}) at or above ${var.disk_usage_alarm_threshold_percent}%."
  namespace           = local.cloudwatch_namespace
  metric_name         = "disk_used_percent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = var.alarm_evaluation_periods
  threshold           = var.disk_usage_alarm_threshold_percent
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  dimensions = {
    InstanceId = aws_instance.this.id
    path       = "/"
    fstype     = "ext4"
  }

  alarm_actions = [local.alarm_topic_arn]
  ok_actions    = [local.alarm_topic_arn]
  tags          = local.tags
}

resource "aws_cloudwatch_metric_alarm" "disk_usage_data" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${local.name}-disk-usage-data"
  alarm_description   = "Data volume (${local.data_mount_path}) disk usage on ${local.name} (${aws_instance.this.id}) at or above ${var.disk_usage_alarm_threshold_percent}%."
  namespace           = local.cloudwatch_namespace
  metric_name         = "disk_used_percent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = var.alarm_evaluation_periods
  threshold           = var.disk_usage_alarm_threshold_percent
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  dimensions = {
    InstanceId = aws_instance.this.id
    path       = local.data_mount_path
    fstype     = "ext4"
  }

  alarm_actions = [local.alarm_topic_arn]
  ok_actions    = [local.alarm_topic_arn]
  tags          = local.tags
}

# ── Auto-recovery: StatusCheckFailed_System -> ec2:recover ─────────────────
# Recovers the instance onto new host hardware on a genuine HOST-level fault
# (loss of network connectivity, loss of system power, a physical-host
# software/hardware issue) — never triggered by anything happening inside the
# guest OS. Verified against AWS's current "CloudWatch action based recovery"
# instance-type support list (docs.aws.amazon.com/AWSEC2/latest/UserGuide/
# cloudwatch-recovery.html, checked 2026-07): the "General purpose" family
# list explicitly includes T3/T3a/T4g (this module's default instance_type
# family), and the only extra constraint ("If instance store volumes are
# added at launch") doesn't apply — this module never attaches instance-store
# volumes, only the root EBS volume + the separate EBS data volume. Recovery
# preserves instance ID, all IPs (incl. the Elastic IP), and re-attaches both
# EBS volumes automatically, so the data volume (storage.tf) is untouched.
# Independent of var.enable_alarms: this alarms on a native AWS/EC2 metric
# that needs no CloudWatch agent, unlike the disk/memory alarms above.
resource "aws_cloudwatch_metric_alarm" "auto_recovery" {
  count             = var.enable_auto_recovery ? 1 : 0
  alarm_name        = "${local.name}-auto-recovery"
  alarm_description = "System status check failed for ${local.name} (${aws_instance.this.id}) — recovering onto new host hardware (arn:aws:automate:${data.aws_region.current.name}:ec2:recover)."
  namespace         = "AWS/EC2"
  metric_name       = "StatusCheckFailed_System"
  # AWS's own console walkthrough for this exact alarm uses "Minimum" over a
  # 1-minute period — with one data point per period (detailed monitoring is
  # on; see aws_instance.this.monitoring in main.tf) Minimum/Maximum/Average
  # are numerically identical for this binary (0/1) metric, so this is purely
  # matching AWS's documented convention.
  statistic = "Minimum"
  period    = 60
  # AWS's documented recommendation: 2 evaluation periods for recover, 3 for
  # reboot (see aws_cloudwatch_metric_alarm.auto_reboot below) — deliberately
  # DIFFERENT counts to avoid a race between the two actions firing together.
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # AWS's explicit guidance for stop/terminate/reboot/recover alarms
  # specifically (as opposed to the notify-only alarms above): treat missing
  # data as "missing", not breaching — a transient metric-reporting gap must
  # never itself trigger a destructive recovery action.
  treat_missing_data = "missing"

  dimensions = {
    InstanceId = aws_instance.this.id
  }

  alarm_actions = compact([
    "arn:aws:automate:${data.aws_region.current.name}:ec2:recover",
    local.alarm_topic_arn,
  ])
  ok_actions = compact([local.alarm_topic_arn])
  tags       = local.tags
}

# ── Auto-reboot: StatusCheckFailed_Instance -> ec2:reboot ──────────────────
# AWS recommends the reboot action specifically for Instance (as opposed to
# System) status-check failures — an OS-level reboot, not a host migration.
# Safe as a default here because of how this box bootstraps: Docker and
# containerd are `systemctl enable`d and kortix-selfhost-bootstrap.service is
# `enable`d (WantedBy=multi-user.target) — see templates/user-data.sh.tftpl —
# so the entire stack self-starts again after any reboot, with zero operator
# involvement (this is the exact mechanism the README's "Bootstrap
# resilience" section documents, originally built for a different problem —
# a slow-cold-start health-check race — but it equally makes an unplanned
# reboot from this alarm safe to recover from unattended).
resource "aws_cloudwatch_metric_alarm" "auto_reboot" {
  count               = var.enable_auto_reboot ? 1 : 0
  alarm_name          = "${local.name}-auto-reboot"
  alarm_description   = "Instance status check failed for ${local.name} (${aws_instance.this.id}) — rebooting (arn:aws:automate:${data.aws_region.current.name}:ec2:reboot)."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  dimensions = {
    InstanceId = aws_instance.this.id
  }

  alarm_actions = compact([
    "arn:aws:automate:${data.aws_region.current.name}:ec2:reboot",
    local.alarm_topic_arn,
  ])
  ok_actions = compact([local.alarm_topic_arn])
  tags       = local.tags
}

# ── Memory usage (CloudWatch agent, "mem" plugin — no per-mount dimension) ─
resource "aws_cloudwatch_metric_alarm" "memory_usage" {
  count               = var.enable_alarms ? 1 : 0
  alarm_name          = "${local.name}-memory-usage"
  alarm_description   = "Memory usage on ${local.name} (${aws_instance.this.id}) at or above ${var.memory_usage_alarm_threshold_percent}%."
  namespace           = local.cloudwatch_namespace
  metric_name         = "mem_used_percent"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = var.alarm_evaluation_periods
  threshold           = var.memory_usage_alarm_threshold_percent
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"

  dimensions = {
    InstanceId = aws_instance.this.id
  }

  alarm_actions = [local.alarm_topic_arn]
  ok_actions    = [local.alarm_topic_arn]
  tags          = local.tags
}
