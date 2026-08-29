# us-east-2 became a production region in July 2026. Keep its edge, alerting,
# network, and backup-failure controls equivalent to the established us-west-2
# and eu-west-2 controls.

data "aws_lbs" "use2" {
  provider = aws.use2
}

data "aws_vpc" "use2" {
  provider = aws.use2

  tags = {
    Name = "kortix-prod-use2-vpc"
  }
}

data "aws_subnets" "use2" {
  provider = aws.use2

  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.use2.id]
  }
}

data "aws_network_acls" "use2_default" {
  provider = aws.use2
  vpc_id   = data.aws_vpc.use2.id

  filter {
    name   = "default"
    values = ["true"]
  }
}

data "aws_iam_role" "flow_logs" {
  name = "vpc-flow-logs-role"
}

locals {
  use2_albs = {
    for arn in data.aws_lbs.use2.arns : arn => {
      name      = split("/", arn)[2]
      dimension = replace(arn, "/^.*:loadbalancer\\//", "")
    }
  }
}

# ── Regional alert delivery ──────────────────────────────────────────────────

data "aws_iam_policy_document" "use2_alerts_kms" {
  # checkov:skip=CKV_AWS_109:The account-root statement is the KMS key control plane. Service principals receive data-key operations only.
  # checkov:skip=CKV_AWS_111:The account root must administer this KMS key. Service access is restricted by SourceAccount.
  # checkov:skip=CKV_AWS_356:KMS key policies require Resource "*" because the key ARN does not exist during policy evaluation.
  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid = "AllowComplianceAlertServices"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]
    principals {
      type = "Service"
      identifiers = [
        "cloudwatch.amazonaws.com",
        "events.amazonaws.com",
      ]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "use2_alerts" {
  provider                = aws.use2
  description             = "Encrypts us-east-2 compliance alert notifications"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.use2_alerts_kms.json
  tags                    = local.tags
}

resource "aws_kms_alias" "use2_alerts" {
  provider      = aws.use2
  name          = "alias/kortix-compliance-alerts"
  target_key_id = aws_kms_key.use2_alerts.key_id
}

resource "aws_sns_topic" "use2_alerts" {
  provider          = aws.use2
  name              = "kortix-compliance-alerts"
  kms_master_key_id = aws_kms_key.use2_alerts.arn
  tags              = local.tags
}

data "aws_iam_policy_document" "use2_alerts" {
  statement {
    sid       = "AllowDrataSubscriptionInspection"
    actions   = ["SNS:GetTopicAttributes", "SNS:ListSubscriptionsByTopic"]
    resources = [aws_sns_topic.use2_alerts.arn]
    principals {
      type        = "AWS"
      identifiers = [local.drata_autopilot_role_arn]
    }
  }

  statement {
    sid = "TopicOwnerAdministration"
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
    resources = [aws_sns_topic.use2_alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowEventBridgeComplianceAlerts"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.use2_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:events:us-east-2:${local.account_id}:rule/kortix-*failures"]
    }
  }

  statement {
    sid       = "AllowCloudWatchAlarmPublish"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.use2_alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudwatch:us-east-2:${local.account_id}:alarm:*"]
    }
  }
}

resource "aws_sns_topic_policy" "use2_alerts" {
  provider = aws.use2
  arn      = aws_sns_topic.use2_alerts.arn
  policy   = data.aws_iam_policy_document.use2_alerts.json
}

# ── WAF and ALB monitoring ────────────────────────────────────────────────────

resource "aws_wafv2_web_acl" "use2" {
  provider    = aws.use2
  name        = "kortix-alb-waf"
  description = "Regional WAF for Kortix production ALBs"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "AWS-Common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        dynamic "rule_action_override" {
          for_each = toset([
            "CrossSiteScripting_BODY",
            "EC2MetaDataSSRF_BODY",
            "GenericLFI_BODY",
            "GenericRFI_BODY",
            "SizeRestrictions_BODY",
          ])
          content {
            name = rule_action_override.value
            action_to_use {
              count {}
            }
          }
        }

        # OAuth 2.0 public clients use loopback redirect URIs. Exclude only this
        # protocol-defined query value from the common managed rule group. The
        # API still validates the complete registered redirect URI.
        scope_down_statement {
          not_statement {
            statement {
              and_statement {
                statement {
                  byte_match_statement {
                    field_to_match {
                      method {}
                    }
                    positional_constraint = "EXACTLY"
                    search_string         = "GET"
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  byte_match_statement {
                    field_to_match {
                      uri_path {}
                    }
                    positional_constraint = "EXACTLY"
                    search_string         = "/v1/oauth/authorize"
                    text_transformation {
                      priority = 0
                      type     = "NONE"
                    }
                  }
                }

                statement {
                  regex_match_statement {
                    field_to_match {
                      single_query_argument {
                        name = "redirect_uri"
                      }
                    }
                    regex_string = "^http://(localhost|127\\.0\\.0\\.1)"
                    text_transformation {
                      priority = 0
                      type     = "URL_DECODE"
                    }
                    text_transformation {
                      priority = 1
                      type     = "LOWERCASE"
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWS-KnownBadInputs"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"

        dynamic "rule_action_override" {
          for_each = toset([
            "JavaDeserializationRCE_BODY",
            "Log4JRCE_BODY",
            "ReactJSRCE_BODY",
          ])
          content {
            name = rule_action_override.value
            action_to_use {
              count {}
            }
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "badinputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWS-IpReputation"
    priority = 3
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "iprep"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "kortix-alb-waf"
    sampled_requests_enabled   = true
  }

  tags = local.tags
}

resource "aws_wafv2_web_acl_association" "use2" {
  provider     = aws.use2
  for_each     = local.use2_albs
  resource_arn = each.key
  web_acl_arn  = aws_wafv2_web_acl.use2.arn
}

data "aws_iam_policy_document" "use2_logs_kms" {
  # checkov:skip=CKV_AWS_109:The account-root statement is the KMS key control plane. CloudWatch Logs receives cryptographic operations only.
  # checkov:skip=CKV_AWS_111:The account root must administer this KMS key. Log access is restricted by encryption context.
  # checkov:skip=CKV_AWS_356:KMS key policies require Resource "*" because the key ARN does not exist during policy evaluation.
  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCloudWatchLogs"
    actions = [
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey",
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.us-east-2.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:us-east-2:${local.account_id}:log-group:*"]
    }
  }
}

resource "aws_kms_key" "use2_logs" {
  provider                = aws.use2
  description             = "Encrypts us-east-2 compliance logs"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.use2_logs_kms.json
  tags                    = local.tags
}

resource "aws_kms_alias" "use2_logs" {
  provider      = aws.use2
  name          = "alias/kortix-compliance-logs"
  target_key_id = aws_kms_key.use2_logs.key_id
}

resource "aws_cloudwatch_log_group" "use2_waf" {
  provider          = aws.use2
  name              = "aws-waf-logs-kortix-alb-waf"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.use2_logs.arn
  tags              = local.tags
}

resource "aws_wafv2_web_acl_logging_configuration" "use2" {
  provider                = aws.use2
  resource_arn            = aws_wafv2_web_acl.use2.arn
  log_destination_configs = [aws_cloudwatch_log_group.use2_waf.arn]
}

removed {
  from = aws_cloudwatch_metric_alarm.use2_target_response_time
  lifecycle {
    destroy = false
  }
}

resource "aws_cloudwatch_metric_alarm" "use2_elb_5xx" {
  provider            = aws.use2
  for_each            = local.use2_albs
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
  alarm_actions       = [aws_sns_topic.use2_alerts.arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "use2_unhealthy_hosts" {
  provider            = aws.use2
  for_each            = local.use2_albs
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
  alarm_actions       = [aws_sns_topic.use2_alerts.arn]
  tags                = local.alarm_tags
}

# ── Backup failure monitoring ─────────────────────────────────────────────────

resource "aws_cloudwatch_event_rule" "use2_backup_failures" {
  provider      = aws.use2
  name          = "kortix-backup-job-failures"
  description   = "Alert on failed, aborted, or expired AWS Backup jobs"
  event_pattern = local.backup_failure_pattern
  tags          = merge(local.tags, { Control = "DCF-99" })
}

resource "aws_cloudwatch_event_rule" "use2_snapshot_failures" {
  provider      = aws.use2
  name          = "kortix-ebs-snapshot-failures"
  description   = "Alert on failed EBS snapshot operations"
  event_pattern = local.snapshot_failure_pattern
  tags          = merge(local.tags, { Control = "DCF-99" })
}

resource "aws_cloudwatch_event_target" "use2_backup_failures" {
  provider  = aws.use2
  rule      = aws_cloudwatch_event_rule.use2_backup_failures.name
  target_id = "compliance-sns"
  arn       = aws_sns_topic.use2_alerts.arn
}

resource "aws_cloudwatch_event_target" "use2_snapshot_failures" {
  provider  = aws.use2
  rule      = aws_cloudwatch_event_rule.use2_snapshot_failures.name
  target_id = "compliance-sns"
  arn       = aws_sns_topic.use2_alerts.arn
}

# ── VPC baseline ───────────────────────────────────────────────────────────────

resource "aws_default_security_group" "use2" {
  provider = aws.use2
  vpc_id   = data.aws_vpc.use2.id

  ingress = []
  egress  = []

  tags = merge(local.tags, {
    Name = "kortix-prod-use2-default"
  })
}

resource "aws_network_acl" "use2_restricted" {
  # checkov:skip=CKV2_AWS_1:All discovered VPC subnets attach through aws_network_acl_association.use2_restricted below.
  provider = aws.use2
  vpc_id   = data.aws_vpc.use2.id

  # Preserve unrestricted VPC-internal traffic.
  ingress {
    protocol   = -1
    rule_no    = 50
    action     = "allow"
    cidr_block = data.aws_vpc.use2.cidr_block
    from_port  = 0
    to_port    = 0
  }

  # Permit public TCP except SSH (22) and RDP (3389).
  ingress {
    protocol   = "tcp"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 21
  }
  ingress {
    protocol   = "tcp"
    rule_no    = 110
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 23
    to_port    = 3388
  }
  ingress {
    protocol   = "tcp"
    rule_no    = 120
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 3390
    to_port    = 65535
  }
  # Permit public UDP except SSH (22) and RDP (3389), mirroring the TCP carve-out.
  ingress {
    protocol   = "udp"
    rule_no    = 130
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 21
  }
  ingress {
    protocol   = "udp"
    rule_no    = 140
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 23
    to_port    = 3388
  }
  ingress {
    protocol   = "udp"
    rule_no    = 150
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 3390
    to_port    = 65535
  }
  ingress {
    protocol   = "icmp"
    rule_no    = 160
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
    icmp_type  = -1
    icmp_code  = -1
  }

  egress {
    protocol   = -1
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = merge(local.tags, {
    Name = "kortix-prod-use2-restricted"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_network_acl_association" "use2_restricted" {
  provider       = aws.use2
  for_each       = toset(data.aws_subnets.use2.ids)
  network_acl_id = aws_network_acl.use2_restricted.id
  subnet_id      = each.value
}

# Adopt and lock the unassociated default ACL only after every production subnet
# uses the fully populated restricted ACL. The AWS provider clears existing
# default ACL rules during first adoption.
resource "aws_default_network_acl" "use2" {
  provider               = aws.use2
  default_network_acl_id = one(data.aws_network_acls.use2_default.ids)

  tags = merge(local.tags, {
    Name = "kortix-prod-use2-default-deny"
  })

  lifecycle {
    ignore_changes = [subnet_ids]
  }

  depends_on = [aws_network_acl_association.use2_restricted]
}

resource "aws_cloudwatch_log_group" "use2_flow_logs" {
  provider          = aws.use2
  name              = "/vpc/flowlogs"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.use2_logs.arn
  tags              = local.tags
}

resource "aws_flow_log" "use2" {
  provider                 = aws.use2
  iam_role_arn             = data.aws_iam_role.flow_logs.arn
  log_destination          = aws_cloudwatch_log_group.use2_flow_logs.arn
  log_destination_type     = "cloud-watch-logs"
  max_aggregation_interval = 60
  traffic_type             = "ALL"
  vpc_id                   = data.aws_vpc.use2.id
  tags                     = local.tags
}
