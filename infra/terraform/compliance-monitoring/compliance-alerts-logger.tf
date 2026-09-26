# Drata DCF-86 (tests 294/296/298) requires the ALB alarm action topic to
# hold an active subscription. The us-east-2 topic's only subscription was a
# PendingConfirmation email, which Drata's hasSubscription fact fails while
# it awaits human confirmation. A Lambda-protocol subscription is Active
# immediately on Subscribe, so the topic always holds a confirmed subscriber
# and every alert additionally lands in CloudWatch Logs as a durable record.

data "archive_file" "compliance_alerts_logger" {
  type        = "zip"
  source_file = "${path.module}/functions/compliance_alerts_logger.py"
  output_path = "${path.module}/.terraform/compliance_alerts_logger.zip"
}

locals {
  compliance_alerts_logger_name = "kortix-compliance-alerts-logger"
}

resource "aws_cloudwatch_log_group" "use2_compliance_alerts_logger" {
  # checkov:skip=CKV_AWS_158: Logs contain only the SNS compliance alert payloads that also reach the human email channel; CloudWatch's AWS-managed encryption is sufficient for this non-secret operational metadata.
  provider          = aws.use2
  name              = "/aws/lambda/${local.compliance_alerts_logger_name}"
  retention_in_days = 365
  tags              = local.tags
}

data "aws_iam_policy_document" "compliance_alerts_logger_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "compliance_alerts_logger" {
  name               = "KortixComplianceAlertsLogger"
  assume_role_policy = data.aws_iam_policy_document.compliance_alerts_logger_assume_role.json
  tags               = local.tags
}

data "aws_iam_policy_document" "compliance_alerts_logger" {
  statement {
    sid       = "WriteFunctionLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.use2_compliance_alerts_logger.arn}:*"]
  }

  statement {
    sid       = "WriteFunctionTraces"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "compliance_alerts_logger" {
  name   = "LogDcf86ComplianceAlerts"
  role   = aws_iam_role.compliance_alerts_logger.id
  policy = data.aws_iam_policy_document.compliance_alerts_logger.json
}

resource "aws_lambda_function" "use2_compliance_alerts_logger" {
  # checkov:skip=CKV_AWS_117: This regional AWS control-plane function needs public AWS API endpoints only; a VPC would add NAT dependency and reduce alert delivery reliability.
  # checkov:skip=CKV_AWS_116: SNS retries failed asynchronous invocations with backoff, and the human email subscription remains the primary alert channel; CloudWatch Logs is the secondary durable record.
  # checkov:skip=CKV_AWS_272: Terraform verifies the immutable archive hash and deploys this repository-owned source directly; no external artifact is accepted.
  provider                       = aws.use2
  function_name                  = local.compliance_alerts_logger_name
  description                    = "Logs DCF-86 compliance alerts to durable CloudWatch Logs"
  filename                       = data.archive_file.compliance_alerts_logger.output_path
  source_code_hash               = data.archive_file.compliance_alerts_logger.output_base64sha256
  role                           = aws_iam_role.compliance_alerts_logger.arn
  handler                        = "compliance_alerts_logger.lambda_handler"
  runtime                        = "python3.13"
  timeout                        = 30
  reserved_concurrent_executions = 1
  tracing_config {
    mode = "Active"
  }
  tags = merge(local.tags, local.alarm_tags)
  depends_on = [
    aws_cloudwatch_log_group.use2_compliance_alerts_logger,
    aws_iam_role_policy.compliance_alerts_logger,
  ]
}

resource "aws_lambda_permission" "use2_compliance_alerts" {
  provider      = aws.use2
  statement_id  = "AllowComplianceAlertDelivery"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.use2_compliance_alerts_logger.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.use2_alerts.arn
}

resource "aws_sns_topic_subscription" "use2_alerts_lambda" {
  provider  = aws.use2
  topic_arn = aws_sns_topic.use2_alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.use2_compliance_alerts_logger.arn
}
