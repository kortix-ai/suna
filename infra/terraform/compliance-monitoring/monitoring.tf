# Regional alert delivery and ALB coverage — Drata DCF-86 / DCF-88 / DCF-99.
#
# ALBs are discovered instead of named because the AWS Load Balancer Controller
# includes a generated hash in Kubernetes-managed load balancer names. A plan
# therefore adds coverage for a new ALB without a hand-maintained name list.

data "aws_sns_topic" "usw2_alerts" {
  name = "suna-api-alerts"
}

data "aws_sns_topic" "euw2_alerts" {
  provider = aws.euw2
  name     = "kortix-compliance-alerts"
}

data "aws_lbs" "usw2" {}

data "aws_lbs" "euw2" {
  provider = aws.euw2
}

# EKS worker instance IDs are ephemeral. Discover every running EC2 instance in
# the two production-system regions so replacement workers receive the same CPU
# alarm on the next plan/apply without maintaining an ID list by hand.
data "aws_instances" "usw2" {
  instance_state_names = ["running"]
}

data "aws_instances" "euw2" {
  provider             = aws.euw2
  instance_state_names = ["running"]
}

data "aws_wafv2_web_acl" "usw2" {
  name  = "kortix-alb-waf"
  scope = "REGIONAL"
}

data "aws_wafv2_web_acl" "euw2" {
  provider = aws.euw2
  name     = "kortix-alb-waf"
  scope    = "REGIONAL"
}

locals {
  usw2_albs = {
    for arn in data.aws_lbs.usw2.arns : arn => {
      name      = split("/", arn)[2]
      dimension = replace(arn, "/^.*:loadbalancer\\//", "")
    }
  }
  euw2_albs = {
    for arn in data.aws_lbs.euw2.arns : arn => {
      name      = split("/", arn)[2]
      dimension = replace(arn, "/^.*:loadbalancer\\//", "")
    }
  }
  alarm_tags = {
    ManagedBy = "kortix-compliance"
    Control   = "DCF-86"
  }
  # Drata's AWS connection assumes this account-local role. Keep its SNS
  # subscription inspection permission explicit and read-only.
  drata_autopilot_role_arn = "arn:aws:iam::${local.account_id}:role/DrataAutopilotRole"
}

data "aws_iam_policy_document" "drata_sns_inspection" {
  statement {
    sid = "ReadAlertTopicSubscriptions"
    actions = [
      "sns:GetTopicAttributes",
      "sns:GetSubscriptionAttributes",
      "sns:ListSubscriptions",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTopics",
    ]
    resources = [data.aws_sns_topic.usw2_alerts.arn, data.aws_sns_topic.euw2_alerts.arn]
  }

  statement {
    sid       = "ListTopicsForInspection"
    actions   = ["sns:ListSubscriptions", "sns:ListTopics"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "drata_sns_inspection" {
  name   = "DrataSNSSubscriptionInspection"
  role   = "DrataAutopilotRole"
  policy = data.aws_iam_policy_document.drata_sns_inspection.json
}

resource "aws_wafv2_web_acl_association" "usw2" {
  for_each     = local.usw2_albs
  resource_arn = each.key
  web_acl_arn  = data.aws_wafv2_web_acl.usw2.arn
}

resource "aws_wafv2_web_acl_association" "euw2" {
  provider     = aws.euw2
  for_each     = local.euw2_albs
  resource_arn = each.key
  web_acl_arn  = data.aws_wafv2_web_acl.euw2.arn
}

resource "aws_cloudwatch_metric_alarm" "usw2_target_response_time" {
  for_each            = local.usw2_albs
  alarm_name          = "kortix-alb-${each.value.name}-target-response-time"
  alarm_description   = "SOC2 DCF-86: ALB target response time is elevated"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = each.value.dimension }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.usw2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "usw2_elb_5xx" {
  for_each            = local.usw2_albs
  alarm_name          = "kortix-alb-${each.value.name}-elb-5xx"
  alarm_description   = "SOC2 DCF-86: ALB server errors detected"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = each.value.dimension }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.usw2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "usw2_unhealthy_hosts" {
  for_each            = local.usw2_albs
  alarm_name          = "kortix-alb-${each.value.name}-unhealthy-hosts"
  alarm_description   = "SOC2 DCF-86: ALB has unhealthy targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = each.value.dimension }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.usw2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "euw2_target_response_time" {
  provider            = aws.euw2
  for_each            = local.euw2_albs
  alarm_name          = "kortix-alb-${each.value.name}-target-response-time"
  alarm_description   = "SOC2 DCF-86: ALB target response time is elevated"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = each.value.dimension }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.euw2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "euw2_elb_5xx" {
  provider            = aws.euw2
  for_each            = local.euw2_albs
  alarm_name          = "kortix-alb-${each.value.name}-elb-5xx"
  alarm_description   = "SOC2 DCF-86: ALB server errors detected"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = each.value.dimension }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.euw2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "euw2_unhealthy_hosts" {
  provider            = aws.euw2
  for_each            = local.euw2_albs
  alarm_name          = "kortix-alb-${each.value.name}-unhealthy-hosts"
  alarm_description   = "SOC2 DCF-86: ALB has unhealthy targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = each.value.dimension }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.euw2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "usw2_instance_cpu" {
  for_each            = toset(data.aws_instances.usw2.ids)
  alarm_name          = "compliance-${each.value}-cpu-high"
  alarm_description   = "EC2 CPU above 80 percent for 15 minutes"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.usw2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "euw2_instance_cpu" {
  provider            = aws.euw2
  for_each            = toset(data.aws_instances.euw2.ids)
  alarm_name          = "compliance-${each.value}-cpu-high"
  alarm_description   = "EC2 CPU above 80 percent for 15 minutes"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.euw2_alerts.arn]
  tags                = local.alarm_tags
}

data "aws_iam_policy_document" "usw2_alerts" {
  statement {
    sid       = "AllowDrataSubscriptionInspection"
    actions   = ["SNS:GetTopicAttributes", "SNS:ListSubscriptionsByTopic"]
    resources = [data.aws_sns_topic.usw2_alerts.arn]
    principals {
      type        = "AWS"
      identifiers = [local.drata_autopilot_role_arn]
    }
  }

  statement {
    sid       = "TopicOwnerAdministration"
    actions   = ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"]
    resources = [data.aws_sns_topic.usw2_alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
  statement {
    sid       = "AllowEventBridgeComplianceAlerts"
    actions   = ["SNS:Publish"]
    resources = [data.aws_sns_topic.usw2_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:events:us-west-2:${local.account_id}:rule/kortix-*failures"]
    }
  }
  statement {
    sid       = "AllowCloudWatchAlarmPublish"
    actions   = ["SNS:Publish"]
    resources = [data.aws_sns_topic.usw2_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:us-west-2:${local.account_id}:alarm:*"]
    }
  }
}

data "aws_iam_policy_document" "euw2_alerts" {
  provider = aws.euw2
  statement {
    sid       = "AllowDrataSubscriptionInspection"
    actions   = ["SNS:GetTopicAttributes", "SNS:ListSubscriptionsByTopic"]
    resources = [data.aws_sns_topic.euw2_alerts.arn]
    principals {
      type        = "AWS"
      identifiers = [local.drata_autopilot_role_arn]
    }
  }

  statement {
    sid       = "TopicOwnerAdministration"
    actions   = ["SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission", "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish"]
    resources = [data.aws_sns_topic.euw2_alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }
  statement {
    sid       = "AllowEventBridgeComplianceAlerts"
    actions   = ["SNS:Publish"]
    resources = [data.aws_sns_topic.euw2_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:events:eu-west-2:${local.account_id}:rule/kortix-*failures"]
    }
  }
  statement {
    sid       = "AllowCloudWatchAlarmPublish"
    actions   = ["SNS:Publish"]
    resources = [data.aws_sns_topic.euw2_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:eu-west-2:${local.account_id}:alarm:*"]
    }
  }
}

resource "aws_sns_topic_policy" "usw2_alerts" {
  arn    = data.aws_sns_topic.usw2_alerts.arn
  policy = data.aws_iam_policy_document.usw2_alerts.json
}

resource "aws_sns_topic_policy" "euw2_alerts" {
  provider = aws.euw2
  arn      = data.aws_sns_topic.euw2_alerts.arn
  policy   = data.aws_iam_policy_document.euw2_alerts.json
}

locals {
  backup_failure_pattern = jsonencode({
    source        = ["aws.backup"]
    "detail-type" = ["Backup Job State Change"]
    detail        = { state = ["FAILED", "ABORTED", "EXPIRED"] }
  })
  snapshot_failure_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EBS Snapshot Notification"]
    detail        = { result = ["failed"] }
  })
}

resource "aws_cloudwatch_event_rule" "usw2_backup_failures" {
  name          = "kortix-backup-job-failures"
  description   = "Alert on failed, aborted, or expired AWS Backup jobs"
  event_pattern = local.backup_failure_pattern
  tags          = merge(local.tags, { Control = "DCF-99" })
}

resource "aws_cloudwatch_event_rule" "usw2_snapshot_failures" {
  name          = "kortix-ebs-snapshot-failures"
  description   = "Alert on failed EBS snapshot operations"
  event_pattern = local.snapshot_failure_pattern
  tags          = merge(local.tags, { Control = "DCF-99" })
}

resource "aws_cloudwatch_event_target" "usw2_backup_failures" {
  rule      = aws_cloudwatch_event_rule.usw2_backup_failures.name
  target_id = "compliance-sns"
  arn       = data.aws_sns_topic.usw2_alerts.arn
}

resource "aws_cloudwatch_event_target" "usw2_snapshot_failures" {
  rule      = aws_cloudwatch_event_rule.usw2_snapshot_failures.name
  target_id = "compliance-sns"
  arn       = data.aws_sns_topic.usw2_alerts.arn
}

resource "aws_cloudwatch_event_rule" "euw2_backup_failures" {
  provider      = aws.euw2
  name          = "kortix-backup-job-failures"
  description   = "Alert on failed, aborted, or expired AWS Backup jobs"
  event_pattern = local.backup_failure_pattern
  tags          = merge(local.tags, { Control = "DCF-99" })
}

resource "aws_cloudwatch_event_rule" "euw2_snapshot_failures" {
  provider      = aws.euw2
  name          = "kortix-ebs-snapshot-failures"
  description   = "Alert on failed EBS snapshot operations"
  event_pattern = local.snapshot_failure_pattern
  tags          = merge(local.tags, { Control = "DCF-99" })
}

resource "aws_cloudwatch_event_target" "euw2_backup_failures" {
  provider  = aws.euw2
  rule      = aws_cloudwatch_event_rule.euw2_backup_failures.name
  target_id = "compliance-sns"
  arn       = data.aws_sns_topic.euw2_alerts.arn
}

resource "aws_cloudwatch_event_target" "euw2_snapshot_failures" {
  provider  = aws.euw2
  rule      = aws_cloudwatch_event_rule.euw2_snapshot_failures.name
  target_id = "compliance-sns"
  arn       = data.aws_sns_topic.euw2_alerts.arn
}
