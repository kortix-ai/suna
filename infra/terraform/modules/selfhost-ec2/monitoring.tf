# Minimal, boring CloudWatch monitoring: an EC2 status-check alarm (no
# agent needed) plus disk/memory alarms fed by the CloudWatch agent that
# templates/user-data.sh.tftpl installs and configures on the box (see the
# "monitoring" section there). Everything here is var-gated by
# var.enable_alarms (default true) — this is a single unmonitored box
# otherwise, which was finding #4 of the 2026-07 production-readiness audit.

# ── IAM: let the box publish CloudWatch agent metrics/logs ─────────────────
resource "aws_iam_role_policy_attachment" "cloudwatch_agent" {
  count      = var.enable_alarms ? 1 : 0
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ── SNS: notify on alarm ────────────────────────────────────────────────────
resource "aws_sns_topic" "alarms" {
  #checkov:skip=CKV_AWS_26:no sensitive payloads pass through this topic (alarm text only) — SNS-managed encryption is the default and adds an unnecessary CMK dependency for a demo/self-host box
  count = var.enable_alarms && var.alarm_sns_topic_arn == "" ? 1 : 0
  name  = "${local.name}-alarms"
  tags  = merge({ ManagedBy = "terraform" }, local.tags)
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
  tags          = merge({ ManagedBy = "terraform" }, local.tags)
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
  tags          = merge({ ManagedBy = "terraform" }, local.tags)
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
  tags          = merge({ ManagedBy = "terraform" }, local.tags)
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
  tags          = merge({ ManagedBy = "terraform" }, local.tags)
}
