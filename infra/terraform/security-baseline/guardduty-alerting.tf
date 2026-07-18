# GuardDuty findings from every enabled region fan into the existing central
# operations alert topic. Regional EventBridge rules satisfy Drata test 105
# without requiring a separate human-confirmed SNS subscription in each region.

data "aws_sns_topic" "operations_alerts" {
  name = "suna-api-alerts"
}

locals {
  guardduty_finding_event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
  })
  central_event_bus_arn = "arn:aws:events:us-west-2:${local.account_id}:event-bus/default"
}

resource "aws_iam_role" "guardduty_event_forwarder" {
  name = "kortix-guardduty-event-forwarder"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy" "guardduty_event_forwarder" {
  name = "put-central-event-bus"
  role = aws_iam_role.guardduty_event_forwarder.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:PutEvents"
      Resource = local.central_event_bus_arn
    }]
  })
}

resource "aws_cloudwatch_event_rule" "guardduty_usw2" {
  name          = "kortix-guardduty-failures"
  description   = "Route all GuardDuty findings to the operations alert topic"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_usw2" {
  rule = aws_cloudwatch_event_rule.guardduty_usw2.name
  arn  = data.aws_sns_topic.operations_alerts.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_use1" {
  provider      = aws.use1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_use1" {
  provider = aws.use1
  rule     = aws_cloudwatch_event_rule.guardduty_use1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_aps1" {
  provider      = aws.aps1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_aps1" {
  provider = aws.aps1
  rule     = aws_cloudwatch_event_rule.guardduty_aps1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_eun1" {
  provider      = aws.eun1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_eun1" {
  provider = aws.eun1
  rule     = aws_cloudwatch_event_rule.guardduty_eun1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_euw3" {
  provider      = aws.euw3
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_euw3" {
  provider = aws.euw3
  rule     = aws_cloudwatch_event_rule.guardduty_euw3.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_euw2" {
  provider      = aws.euw2
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_euw2" {
  provider = aws.euw2
  rule     = aws_cloudwatch_event_rule.guardduty_euw2.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_euw1" {
  provider      = aws.euw1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_euw1" {
  provider = aws.euw1
  rule     = aws_cloudwatch_event_rule.guardduty_euw1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_apne3" {
  provider      = aws.apne3
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_apne3" {
  provider = aws.apne3
  rule     = aws_cloudwatch_event_rule.guardduty_apne3.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_apne2" {
  provider      = aws.apne2
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_apne2" {
  provider = aws.apne2
  rule     = aws_cloudwatch_event_rule.guardduty_apne2.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_apne1" {
  provider      = aws.apne1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_apne1" {
  provider = aws.apne1
  rule     = aws_cloudwatch_event_rule.guardduty_apne1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_cac1" {
  provider      = aws.cac1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_cac1" {
  provider = aws.cac1
  rule     = aws_cloudwatch_event_rule.guardduty_cac1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_sae1" {
  provider      = aws.sae1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_sae1" {
  provider = aws.sae1
  rule     = aws_cloudwatch_event_rule.guardduty_sae1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_apse1" {
  provider      = aws.apse1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_apse1" {
  provider = aws.apse1
  rule     = aws_cloudwatch_event_rule.guardduty_apse1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_apse2" {
  provider      = aws.apse2
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_apse2" {
  provider = aws.apse2
  rule     = aws_cloudwatch_event_rule.guardduty_apse2.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_euc1" {
  provider      = aws.euc1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_euc1" {
  provider = aws.euc1
  rule     = aws_cloudwatch_event_rule.guardduty_euc1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_use2" {
  provider      = aws.use2
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_use2" {
  provider = aws.use2
  rule     = aws_cloudwatch_event_rule.guardduty_use2.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

resource "aws_cloudwatch_event_rule" "guardduty_usw1" {
  provider      = aws.usw1
  name          = "kortix-guardduty-findings"
  description   = "Forward GuardDuty findings to the central operations alert bus"
  event_pattern = local.guardduty_finding_event_pattern
  state         = "ENABLED"
  tags          = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty_usw1" {
  provider = aws.usw1
  rule     = aws_cloudwatch_event_rule.guardduty_usw1.name
  arn      = local.central_event_bus_arn
  role_arn = aws_iam_role.guardduty_event_forwarder.arn
}

