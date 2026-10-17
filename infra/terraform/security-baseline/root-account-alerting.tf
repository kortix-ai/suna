# Successful AWS root-account console logins are exceptional security events.
# AWS Sign-In emits the CloudTrail-backed event in us-east-1, so forward it to
# the central eu-west-2 event bus and deliver it through the confirmed
# compliance alert topic there (SOC 2 DCF-90). us-west-2 keeps a forwarder for
# a sign-in through its regional endpoint; it was the hub until 2026-10-12.

locals {
  root_console_login_event_pattern = jsonencode({
    source        = ["aws.signin"]
    "detail-type" = ["AWS Console Sign In via CloudTrail"]
    detail = {
      eventSource = ["signin.amazonaws.com"]
      eventName   = ["ConsoleLogin"]
      userIdentity = {
        type = ["Root"]
      }
      responseElements = {
        ConsoleLogin = ["Success"]
      }
    }
  })
}

resource "aws_cloudwatch_event_rule" "root_login_use1" {
  provider      = aws.use1
  name          = "kortix-root-login-failures"
  description   = "Forward successful AWS root-account console logins to operations"
  event_pattern = local.root_console_login_event_pattern
  state         = "ENABLED"
  tags          = merge(local.tags, { Control = "DCF-90" })
}

resource "aws_cloudwatch_event_target" "root_login_use1" {
  provider = aws.use1
  rule     = aws_cloudwatch_event_rule.root_login_use1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "root_login_usw2" {
  name          = "kortix-root-login-failures"
  description   = "Forward successful AWS root-account console logins to operations"
  event_pattern = local.root_console_login_event_pattern
  state         = "ENABLED"
  tags          = merge(local.tags, { Control = "DCF-90" })
}

resource "aws_cloudwatch_event_target" "root_login_usw2" {
  rule     = aws_cloudwatch_event_rule.root_login_usw2.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

# The central delivery rule. Its name must match the topic policy's
# `rule/kortix-*failures` publish condition (compliance-monitoring/monitoring.tf).
resource "aws_cloudwatch_event_rule" "root_login_euw2" {
  provider      = aws.euw2
  name          = "kortix-root-login-failures"
  description   = "Deliver successful AWS root-account console logins to operations"
  event_pattern = local.root_console_login_event_pattern
  state         = "ENABLED"
  tags          = merge(local.tags, { Control = "DCF-90" })
}

resource "aws_cloudwatch_event_target" "root_login_euw2" {
  provider = aws.euw2
  rule     = aws_cloudwatch_event_rule.root_login_euw2.name
  arn      = data.aws_sns_topic.operations_alerts.arn
}
