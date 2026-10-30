mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/synthetic" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/synthetic" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-2:123456789012:synthetic" }
  }

  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
}

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/synthetic" }
  }

  alias = "euw2"
  mock_data "aws_lbs" {
    defaults = { arns = [] }
  }
  mock_data "aws_instances" {
    defaults = { ids = [] }
  }
  mock_data "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-west-2:123456789012:kortix-compliance-alerts" }
  }
}

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }

  alias = "use2"
  mock_data "aws_lbs" {
    defaults = { arns = [] }
  }
  mock_data "aws_instances" {
    defaults = { ids = [] }
  }
}

run "euw2_manifest_queue_age_coverage" {
  command = plan

  assert {
    condition = toset([
      for alarm in aws_cloudwatch_metric_alarm.euw2_sqs_oldest_message_age : alarm.dimensions.QueueName
      ]) == toset([
      "kortix-prod-capture-store-manifests",
      "kortix-prod-capture-store-manifests-dlq",
      "kortix-staging-euw2-capture-store-manifests",
      "kortix-staging-euw2-capture-store-manifests-dlq",
    ])
    error_message = "Every production and staging manifest queue, including DLQs, needs an age alarm."
  }

  assert {
    condition = alltrue([
      for alarm in aws_cloudwatch_metric_alarm.euw2_sqs_oldest_message_age :
      alarm.namespace == "AWS/SQS" &&
      alarm.metric_name == "ApproximateAgeOfOldestMessage" &&
      alarm.statistic == "Maximum" &&
      alarm.period == 300 &&
      alarm.evaluation_periods == 3 &&
      alarm.datapoints_to_alarm == 3 &&
      alarm.threshold == 900 &&
      alarm.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      alarm.treat_missing_data == "notBreaching" &&
      alarm.alarm_actions == toset(["arn:aws:sns:eu-west-2:123456789012:kortix-compliance-alerts"]) &&
      alarm.tags.Control == "DCF-86"
    ])
    error_message = "Age alarms must detect sustained stalls and notify the regional compliance topic."
  }
}
