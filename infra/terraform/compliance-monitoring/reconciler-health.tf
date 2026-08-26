# A reconciler that crashes is a control that never runs. The ALB alarm
# reconciler raised AccessDenied on elasticloadbalancing:DescribeTargetGroups on
# every five-minute tick from 2026-08-06 to 2026-08-26 and nobody knew: the
# schedule was ENABLED, the function was Active, and CloudWatch only showed the
# failure to someone who opened the log group. These alarms page the regional
# alert topic on the first errored invocation and stay in ALARM until a tick
# succeeds again.

locals {
  reconciler_functions = {
    usw2 = {
      provider_key = "usw2"
      topic_arn    = data.aws_sns_topic.usw2_alerts.arn
      functions = [
        aws_lambda_function.usw2_alb_alarm_reconciler.function_name,
        aws_lambda_function.usw2_ec2_cpu_reconciler.function_name,
      ]
    }
    euw2 = {
      provider_key = "euw2"
      topic_arn    = data.aws_sns_topic.euw2_alerts.arn
      functions = [
        aws_lambda_function.euw2_alb_alarm_reconciler.function_name,
        aws_lambda_function.euw2_ec2_cpu_reconciler.function_name,
      ]
    }
    use2 = {
      provider_key = "use2"
      topic_arn    = aws_sns_topic.use2_alerts.arn
      functions = [
        aws_lambda_function.use2_alb_alarm_reconciler.function_name,
      ]
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "usw2_reconciler_errors" {
  for_each            = toset(local.reconciler_functions.usw2.functions)
  alarm_name          = "kortix-compliance-${each.value}-errors"
  alarm_description   = "SOC2 DCF-86: a compliance reconciler Lambda is failing; its alarms are no longer maintained"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.reconciler_functions.usw2.topic_arn]
  ok_actions          = [local.reconciler_functions.usw2.topic_arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "euw2_reconciler_errors" {
  provider            = aws.euw2
  for_each            = toset(local.reconciler_functions.euw2.functions)
  alarm_name          = "kortix-compliance-${each.value}-errors"
  alarm_description   = "SOC2 DCF-86: a compliance reconciler Lambda is failing; its alarms are no longer maintained"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.reconciler_functions.euw2.topic_arn]
  ok_actions          = [local.reconciler_functions.euw2.topic_arn]
  tags                = local.alarm_tags
}

resource "aws_cloudwatch_metric_alarm" "use2_reconciler_errors" {
  provider            = aws.use2
  for_each            = toset(local.reconciler_functions.use2.functions)
  alarm_name          = "kortix-compliance-${each.value}-errors"
  alarm_description   = "SOC2 DCF-86: a compliance reconciler Lambda is failing; its alarms are no longer maintained"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.reconciler_functions.use2.topic_arn]
  ok_actions          = [local.reconciler_functions.use2.topic_arn]
  tags                = local.alarm_tags
}
