# Terraform establishes the baseline alarms, while this reconciler closes the
# gap between Kubernetes-managed ALB rotation and the next Terraform apply. A
# five-minute schedule repairs missing alarms, stale dimensions, and SNS drift.

data "archive_file" "alb_alarm_reconciler" {
  type        = "zip"
  source_file = "${path.module}/functions/alb_alarm_reconciler.py"
  output_path = "${path.module}/.terraform/alb_alarm_reconciler.zip"
}

locals {
  alb_alarm_reconciler_name = "kortix-alb-alarm-reconciler"
}

resource "aws_cloudwatch_log_group" "usw2_alb_alarm_reconciler" {
  # checkov:skip=CKV_AWS_158: Logs contain only ALB names and reconciliation counts; CloudWatch's AWS-managed encryption is sufficient for this non-secret operational metadata.
  name              = "/aws/lambda/${local.alb_alarm_reconciler_name}"
  retention_in_days = 365
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "euw2_alb_alarm_reconciler" {
  # checkov:skip=CKV_AWS_158: Logs contain only ALB names and reconciliation counts; CloudWatch's AWS-managed encryption is sufficient for this non-secret operational metadata.
  provider          = aws.euw2
  name              = "/aws/lambda/${local.alb_alarm_reconciler_name}"
  retention_in_days = 365
  tags              = local.tags
}

resource "aws_cloudwatch_log_group" "use2_alb_alarm_reconciler" {
  # checkov:skip=CKV_AWS_158: Logs contain only ALB names and reconciliation counts; CloudWatch's AWS-managed encryption is sufficient for this non-secret operational metadata.
  provider          = aws.use2
  name              = "/aws/lambda/${local.alb_alarm_reconciler_name}"
  retention_in_days = 365
  tags              = local.tags
}

resource "aws_lambda_function" "usw2_alb_alarm_reconciler" {
  # checkov:skip=CKV_AWS_117: This regional AWS control-plane function needs public AWS API endpoints only; a VPC would add NAT dependency and reduce repair reliability.
  # checkov:skip=CKV_AWS_116: EventBridge retries failed delivery and the five-minute schedule is the durable retry path.
  # checkov:skip=CKV_AWS_173: The sole environment value is a public SNS ARN, not a secret; Lambda still encrypts it with the AWS-managed key.
  # checkov:skip=CKV_AWS_272: Terraform verifies the immutable archive hash and deploys this repository-owned source directly; no external artifact is accepted.
  function_name                  = local.alb_alarm_reconciler_name
  description                    = "Reconciles DCF-86 alarms for every application load balancer"
  filename                       = data.archive_file.alb_alarm_reconciler.output_path
  source_code_hash               = data.archive_file.alb_alarm_reconciler.output_base64sha256
  role                           = aws_iam_role.ec2_cpu_reconciler.arn
  handler                        = "alb_alarm_reconciler.lambda_handler"
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
    aws_cloudwatch_log_group.usw2_alb_alarm_reconciler,
    aws_iam_role_policy.ec2_cpu_reconciler,
  ]
}

resource "aws_lambda_function" "euw2_alb_alarm_reconciler" {
  # checkov:skip=CKV_AWS_117: This regional AWS control-plane function needs public AWS API endpoints only; a VPC would add NAT dependency and reduce repair reliability.
  # checkov:skip=CKV_AWS_116: EventBridge retries failed delivery and the five-minute schedule is the durable retry path.
  # checkov:skip=CKV_AWS_173: The sole environment value is a public SNS ARN, not a secret; Lambda still encrypts it with the AWS-managed key.
  # checkov:skip=CKV_AWS_272: Terraform verifies the immutable archive hash and deploys this repository-owned source directly; no external artifact is accepted.
  provider                       = aws.euw2
  function_name                  = local.alb_alarm_reconciler_name
  description                    = "Reconciles DCF-86 alarms for every application load balancer"
  filename                       = data.archive_file.alb_alarm_reconciler.output_path
  source_code_hash               = data.archive_file.alb_alarm_reconciler.output_base64sha256
  role                           = aws_iam_role.ec2_cpu_reconciler.arn
  handler                        = "alb_alarm_reconciler.lambda_handler"
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
    aws_cloudwatch_log_group.euw2_alb_alarm_reconciler,
    aws_iam_role_policy.ec2_cpu_reconciler,
  ]
}

resource "aws_lambda_function" "use2_alb_alarm_reconciler" {
  # checkov:skip=CKV_AWS_117: This regional AWS control-plane function needs public AWS API endpoints only; a VPC would add NAT dependency and reduce repair reliability.
  # checkov:skip=CKV_AWS_116: EventBridge retries failed delivery and the five-minute schedule is the durable retry path.
  # checkov:skip=CKV_AWS_173: The sole environment value is a public SNS ARN, not a secret; Lambda still encrypts it with the AWS-managed key.
  # checkov:skip=CKV_AWS_272: Terraform verifies the immutable archive hash and deploys this repository-owned source directly; no external artifact is accepted.
  provider                       = aws.use2
  function_name                  = local.alb_alarm_reconciler_name
  description                    = "Reconciles DCF-86 alarms for every application load balancer"
  filename                       = data.archive_file.alb_alarm_reconciler.output_path
  source_code_hash               = data.archive_file.alb_alarm_reconciler.output_base64sha256
  role                           = aws_iam_role.ec2_cpu_reconciler.arn
  handler                        = "alb_alarm_reconciler.lambda_handler"
  runtime                        = "python3.13"
  timeout                        = 30
  reserved_concurrent_executions = 1
  environment {
    variables = { ALERT_TOPIC_ARN = aws_sns_topic.use2_alerts.arn }
  }
  tracing_config {
    mode = "Active"
  }
  tags = merge(local.tags, local.alarm_tags)
  depends_on = [
    aws_cloudwatch_log_group.use2_alb_alarm_reconciler,
    aws_iam_role_policy.ec2_cpu_reconciler,
  ]
}

resource "aws_cloudwatch_event_rule" "usw2_alb_alarm_reconcile_schedule" {
  name                = "kortix-alb-alarm-reconcile-schedule"
  description         = "Repair missing or drifted DCF-86 ALB alarms"
  schedule_expression = "rate(5 minutes)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_rule" "euw2_alb_alarm_reconcile_schedule" {
  provider            = aws.euw2
  name                = "kortix-alb-alarm-reconcile-schedule"
  description         = "Repair missing or drifted DCF-86 ALB alarms"
  schedule_expression = "rate(5 minutes)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_rule" "use2_alb_alarm_reconcile_schedule" {
  provider            = aws.use2
  name                = "kortix-alb-alarm-reconcile-schedule"
  description         = "Repair missing or drifted DCF-86 ALB alarms"
  schedule_expression = "rate(5 minutes)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "usw2_alb_alarm_reconcile_schedule" {
  rule = aws_cloudwatch_event_rule.usw2_alb_alarm_reconcile_schedule.name
  arn  = aws_lambda_function.usw2_alb_alarm_reconciler.arn
}

resource "aws_cloudwatch_event_target" "euw2_alb_alarm_reconcile_schedule" {
  provider = aws.euw2
  rule     = aws_cloudwatch_event_rule.euw2_alb_alarm_reconcile_schedule.name
  arn      = aws_lambda_function.euw2_alb_alarm_reconciler.arn
}

resource "aws_cloudwatch_event_target" "use2_alb_alarm_reconcile_schedule" {
  provider = aws.use2
  rule     = aws_cloudwatch_event_rule.use2_alb_alarm_reconcile_schedule.name
  arn      = aws_lambda_function.use2_alb_alarm_reconciler.arn
}

resource "aws_lambda_permission" "usw2_alb_alarm_reconcile_schedule" {
  statement_id  = "AllowScheduledAlbReconciliation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.usw2_alb_alarm_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.usw2_alb_alarm_reconcile_schedule.arn
}

resource "aws_lambda_permission" "euw2_alb_alarm_reconcile_schedule" {
  provider      = aws.euw2
  statement_id  = "AllowScheduledAlbReconciliation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.euw2_alb_alarm_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.euw2_alb_alarm_reconcile_schedule.arn
}

resource "aws_lambda_permission" "use2_alb_alarm_reconcile_schedule" {
  provider      = aws.use2
  statement_id  = "AllowScheduledAlbReconciliation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.use2_alb_alarm_reconciler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.use2_alb_alarm_reconcile_schedule.arn
}
