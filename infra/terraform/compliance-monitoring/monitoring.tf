# Regional alert delivery and ALB coverage — Drata DCF-86 / DCF-88 / DCF-99.
#
# ALBs are discovered instead of named because the AWS Load Balancer Controller
# includes a generated hash in Kubernetes-managed load balancer names. A plan
# therefore adds coverage for a new ALB without a hand-maintained name list.
#
# us-west-2 runs no workload since 2026-10-12. Its last alert source is the AWS
# Backup job for the Terraform lock table, which forwards to eu-west-2 (below).

data "aws_sns_topic" "euw2_alerts" {
  provider = aws.euw2
  name     = "kortix-compliance-alerts"
}

data "aws_lbs" "euw2" {
  provider = aws.euw2
}

# EKS worker instance IDs are ephemeral. Discover every running EC2 instance in
# the production region so replacement workers receive the same CPU alarm on
# the next plan/apply without maintaining an ID list by hand.
data "aws_instances" "euw2" {
  provider             = aws.euw2
  instance_state_names = ["running"]
}

data "aws_wafv2_web_acl" "euw2" {
  provider = aws.euw2
  name     = "kortix-alb-waf"
  scope    = "REGIONAL"
}

locals {
  euw2_albs = {
    for arn in data.aws_lbs.euw2.arns : arn => {
      name      = split("/", arn)[2]
      dimension = replace(arn, "/^.*:loadbalancer\\//", "")
    }
  }
  euw2_compliance_waf_albs = {
    for arn, alb in local.euw2_albs : arn => alb
    if !contains(["kortix-prod-web-alb", "kortix-staging-euw2-web-alb"], alb.name)
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
    resources = [
      data.aws_sns_topic.euw2_alerts.arn,
      aws_sns_topic.use2_alerts.arn,
    ]
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

resource "aws_wafv2_web_acl_association" "euw2" {
  provider     = aws.euw2
  for_each     = local.euw2_compliance_waf_albs
  resource_arn = each.key
  web_acl_arn  = data.aws_wafv2_web_acl.euw2.arn
}

# TargetResponseTime was retired on 2026-08-26 after its 2 s threshold flapped
# on streaming traffic (6-11 s averages are normal for the gateway and API ALBs;
# ~300 SNS emails in one day, zero incidents). Drata DCF-86 / test 294 requires
# the alarm on every ALB, so it is restored with a threshold the workload does
# not cross in steady state: the worst 15-minute average in the 14 days before
# restoration was ~25 s (dev API ALB), so Average > 30 s held for three
# consecutive 5-minute periods only fires on a genuine stall. Keep the
# threshold above observed streaming traffic if it is ever retuned.
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
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 30
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

  # The alb_alarm_reconciler Lambda (functions/alb_alarm_reconciler.py) owns the
  # dimensions of this alarm: it writes {TargetGroup, LoadBalancer}, because
  # UnHealthyHostCount has no LoadBalancer-only series. Terraform manages the
  # alarm but must not reset the dimensions to the LoadBalancer-only set, which
  # reads no data and so never fires (treat_missing_data = notBreaching).
  lifecycle {
    ignore_changes = [dimensions]
  }
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
  # GuardDuty and root-login delivery rules (security-baseline) and the backup
  # and snapshot rules below all publish through this one condition: every
  # delivery rule in eu-west-2 is named kortix-*failures.
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

# AWS Backup runs in eu-west-2 only (security-baseline/main.tf), so its
# failures need no cross-region forwarder.
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

# DCF-406: every VPC carries a flow log. kortix-prod-vpc writes to this group
# through a flow log created by CLI; the staging VPC had none until 2026-10-12.
data "aws_vpc" "euw2_staging" {
  provider = aws.euw2
  tags     = { Name = "kortix-staging-euw2-vpc" }
}

data "aws_iam_role" "flow_logs" {
  name = "vpc-flow-logs-role"
}

resource "aws_flow_log" "euw2_staging" {
  provider             = aws.euw2
  iam_role_arn         = data.aws_iam_role.flow_logs.arn
  log_destination      = "arn:aws:logs:eu-west-2:${local.account_id}:log-group:/vpc/flowlogs"
  log_destination_type = "cloud-watch-logs"
  traffic_type         = "ALL"
  vpc_id               = data.aws_vpc.euw2_staging.id
  tags                 = local.tags
}

# Drata test 233 (CIS 5.4): the default security group allows no traffic.
# Nothing attaches it; every ECS service carries its own group.
resource "aws_default_security_group" "euw2_staging" {
  provider = aws.euw2
  vpc_id   = data.aws_vpc.euw2_staging.id

  ingress = []
  egress  = []

  tags = {
    ManagedBy  = "terraform"
    Stack      = "compliance-monitoring"
    Compliance = "soc2"
    Name       = "kortix-staging-euw2-default"
  }
}
