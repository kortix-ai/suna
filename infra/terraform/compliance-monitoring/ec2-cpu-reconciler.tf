# Terraform establishes the baseline alarms below, while this reconciler closes
# the gap between EKS node replacement and the next Terraform apply. Every EC2
# running-state event triggers it, and a five-minute schedule provides a repair
# path for missed events or configuration drift.

data "archive_file" "ec2_cpu_alarm_reconciler" {
  type        = "zip"
  source_file = "${path.module}/functions/ec2_cpu_alarm_reconciler.py"
  output_path = "${path.module}/.terraform/ec2_cpu_alarm_reconciler.zip"
}

locals {
  ec2_cpu_reconciler_name = "kortix-ec2-cpu-alarm-reconciler"
}

data "aws_iam_policy_document" "ec2_cpu_reconciler_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_cpu_reconciler" {
  name               = "KortixEc2CpuAlarmReconciler"
  assume_role_policy = data.aws_iam_policy_document.ec2_cpu_reconciler_assume_role.json
  tags               = local.tags
}

data "aws_iam_policy_document" "ec2_cpu_reconciler" {
  # checkov:skip=CKV_AWS_356: DescribeInstances, DescribeAlarms, and X-Ray telemetry APIs do not support resource-level permissions; alarm writes remain ARN-scoped below.
  statement {
    sid       = "DiscoverRunningInstancesAndAlarms"
    actions   = ["ec2:DescribeInstances", "cloudwatch:DescribeAlarms"]
    resources = ["*"]
  }

  statement {
    sid     = "ReconcileDcf86CpuAlarms"
    actions = ["cloudwatch:PutMetricAlarm", "cloudwatch:TagResource"]
    resources = [
      "arn:aws:cloudwatch:us-west-2:${local.account_id}:alarm:compliance-*-cpu-high",
      "arn:aws:cloudwatch:eu-west-2:${local.account_id}:alarm:compliance-*-cpu-high",
    ]
  }

  statement {
    sid     = "WriteFunctionLogs"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "${aws_cloudwatch_log_group.usw2_ec2_cpu_reconciler.arn}:*",
      "${aws_cloudwatch_log_group.euw2_ec2_cpu_reconciler.arn}:*",
    ]
  }

  statement {
    sid       = "WriteFunctionTraces"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ec2_cpu_reconciler" {
  name   = "ReconcileDcf86Ec2CpuAlarms"
  role   = aws_iam_role.ec2_cpu_reconciler.id
  policy = data.aws_iam_policy_document.ec2_cpu_reconciler.json
}

resource "aws_cloudwatch_log_group" "usw2_ec2_cpu_reconciler" {
  # checkov:skip=CKV_AWS_158: Logs contain only instance IDs and reconciliation counts; CloudWatch's AWS-managed encryption is sufficient for this non-secret operational metadata.
  name              = "/aws/lambda/${local.ec2_cpu_reconciler_name}"
  retention_in_days = 365
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "euw2_ec2_cpu_reconciler" {
  # checkov:skip=CKV_AWS_158: Logs contain only instance IDs and reconciliation counts; CloudWatch's AWS-managed encryption is sufficient for this non-secret operational metadata.
  provider          = aws.euw2
  name              = "/aws/lambda/${local.ec2_cpu_reconciler_name}"
  retention_in_days = 365
  tags              = local.tags
}

resource "aws_lambda_function" "usw2_ec2_cpu_reconciler" {
  # checkov:skip=CKV_AWS_117: This regional AWS control-plane function needs public AWS API endpoints only; a VPC would add NAT dependency and reduce repair reliability.
  # checkov:skip=CKV_AWS_116: EventBridge retries failed delivery and the independent five-minute schedule is the durable retry path.
  # checkov:skip=CKV_AWS_173: The sole environment value is a public SNS ARN, not a secret; Lambda still encrypts it with the AWS-managed key.
  # checkov:skip=CKV_AWS_272: Terraform verifies the immutable archive hash and deploys this repository-owned source directly; no external artifact is accepted.
  function_name                  = local.ec2_cpu_reconciler_name
  description                    = "Reconciles DCF-86 CPU alarms for every running EC2 instance"
  filename                       = data.archive_file.ec2_cpu_alarm_reconciler.output_path
  source_code_hash               = data.archive_file.ec2_cpu_alarm_reconciler.output_base64sha256
  role                           = aws_iam_role.ec2_cpu_reconciler.arn
  handler                        = "ec2_cpu_alarm_reconciler.lambda_handler"
  runtime                        = "python3.13"
  timeout                        = 30
  reserved_concurrent_executions = 1
  environment {
    variables = { ALERT_TOPIC_ARN = data.aws_sns_topic.usw2_alerts.arn }
  }
  tracing_config {
    mode = "Active"
  }
  tags = merge(local.tags, local.alarm_tags)
  depends_on = [
    aws_cloudwatch_log_group.usw2_ec2_cpu_reconciler,
    aws_iam_role_policy.ec2_cpu_reconciler,
  ]
}

resource "aws_lambda_function" "euw2_ec2_cpu_reconciler" {
  # checkov:skip=CKV_AWS_117: This regional AWS control-plane function needs public AWS API endpoints only; a VPC would add NAT dependency and reduce repair reliability.
  # checkov:skip=CKV_AWS_116: EventBridge retries failed delivery and the independent five-minute schedule is the durable retry path.
  # checkov:skip=CKV_AWS_173: The sole environment value is a public SNS ARN, not a secret; Lambda still encrypts it with the AWS-managed key.
  # checkov:skip=CKV_AWS_272: Terraform verifies the immutable archive hash and deploys this repository-owned source directly; no external artifact is accepted.
  provider                       = aws.euw2
  function_name                  = local.ec2_cpu_reconciler_name
  description                    = "Reconciles DCF-86 CPU alarms for every running EC2 instance"
  filename                       = data.archive_file.ec2_cpu_alarm_reconciler.output_path
  source_code_hash               = data.archive_file.ec2_cpu_alarm_reconciler.output_base64sha256
  role                           = aws_iam_role.ec2_cpu_reconciler.arn
  handler                        = "ec2_cpu_alarm_reconciler.lambda_handler"
  runtime                        = "python3.13"
  timeout                        = 30
  reserved_concurrent_executions = 1
  environment {
    variables = { ALERT_TOPIC_ARN = data.aws_sns_topic.euw2_alerts.arn }
  }
  tracing_config {
    mode = "Active"
  }
  tags = merge(local.tags, local.alarm_tags)
  depends_on = [
    aws_cloudwatch_log_group.euw2_ec2_cpu_reconciler,
    aws_iam_role_policy.ec2_cpu_reconciler,
  ]
}

resource "aws_cloudwatch_event_rule" "usw2_ec2_running" {
  name        = "kortix-ec2-running-cpu-alarm-reconcile"
  description = "Create or repair the DCF-86 CPU alarm when an EC2 instance starts"
  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Instance State-change Notification"]
    detail      = { state = ["running"] }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_rule" "euw2_ec2_running" {
  provider    = aws.euw2
  name        = "kortix-ec2-running-cpu-alarm-reconcile"
  description = "Create or repair the DCF-86 CPU alarm when an EC2 instance starts"
  event_pattern = jsonencode({
    source      = ["aws.ec2"]
    detail-type = ["EC2 Instance State-change Notification"]
    detail      = { state = ["running"] }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_rule" "usw2_ec2_cpu_reconcile_schedule" {
  name                = "kortix-ec2-cpu-alarm-reconcile-schedule"
  description         = "Repair missing or drifted DCF-86 EC2 CPU alarms"
  schedule_expression = "rate(5 minutes)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_rule" "euw2_ec2_cpu_reconcile_schedule" {
  provider            = aws.euw2
  name                = "kortix-ec2-cpu-alarm-reconcile-schedule"
  description         = "Repair missing or drifted DCF-86 EC2 CPU alarms"
  schedule_expression = "rate(5 minutes)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "usw2_ec2_running" {
  rule = aws_cloudwatch_event_rule.usw2_ec2_running.name
  arn  = aws_lambda_function.usw2_ec2_cpu_reconciler.arn
}

resource "aws_cloudwatch_event_target" "euw2_ec2_running" {
  provider = aws.euw2
  rule     = aws_cloudwatch_event_rule.euw2_ec2_running.name
  arn      = aws_lambda_function.euw2_ec2_cpu_reconciler.arn
}

resource "aws_cloudwatch_event_target" "usw2_ec2_cpu_reconcile_schedule" {
  rule = aws_cloudwatch_event_rule.usw2_ec2_cpu_reconcile_schedule.name
  arn  = aws_lambda_function.usw2_ec2_cpu_reconciler.arn
}

resource "aws_cloudwatch_event_target" "euw2_ec2_cpu_reconcile_schedule" {
  provider = aws.euw2
  rule     = aws_cloudwatch_event_rule.euw2_ec2_cpu_reconcile_schedule.name
  arn      = aws_lambda_function.euw2_ec2_cpu_reconciler.arn
}

resource "aws_lambda_permission" "usw2_ec2_running" {
  statement_id  = "AllowEc2RunningEvents"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.usw2_ec2_cpu_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.usw2_ec2_running.arn
}

resource "aws_lambda_permission" "euw2_ec2_running" {
  provider      = aws.euw2
  statement_id  = "AllowEc2RunningEvents"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.euw2_ec2_cpu_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.euw2_ec2_running.arn
}

resource "aws_lambda_permission" "usw2_ec2_cpu_reconcile_schedule" {
  statement_id  = "AllowScheduledReconciliation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.usw2_ec2_cpu_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.usw2_ec2_cpu_reconcile_schedule.arn
}

resource "aws_lambda_permission" "euw2_ec2_cpu_reconcile_schedule" {
  provider      = aws.euw2
  statement_id  = "AllowScheduledReconciliation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.euw2_ec2_cpu_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.euw2_ec2_cpu_reconcile_schedule.arn
}
