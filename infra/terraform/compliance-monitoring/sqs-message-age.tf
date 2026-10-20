# Capture-store queues in eu-west-2 are not covered by the dev us-east-2 alarms.
# Keep full queue names in alarm names: prod and staging share this region.
locals {
  euw2_sqs_queues = toset([
    "kortix-prod-capture-store-manifests",
    "kortix-prod-capture-store-manifests-dlq",
    "kortix-staging-euw2-capture-store-manifests",
    "kortix-staging-euw2-capture-store-manifests-dlq",
  ])
}

resource "aws_cloudwatch_metric_alarm" "euw2_sqs_oldest_message_age" {
  provider            = aws.euw2
  for_each            = local.euw2_sqs_queues
  alarm_name          = "${each.key}-oldest-message-age"
  alarm_description   = "SOC2 DCF-86: SQS manifest queue message age is elevated"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = each.key }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 900
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [data.aws_sns_topic.euw2_alerts.arn]
  tags                = local.alarm_tags
}
