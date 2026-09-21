#!/usr/bin/env python3
"""Regression test: Drata DCF-86 / test 294 ALB TargetResponseTime coverage.

Drata fails every ALB without a TargetResponseTime CloudWatch alarm that
notifies an SNS topic, and every such topic without a subscription. The alarm
family was retired on 2026-08-26 after its 2 s threshold flapped on streaming
traffic, which is exactly the state Drata flags. These tests keep the restored
family complete (same per-ALB discovery maps as the sibling alarms), keep the
threshold above the by-design streaming averages so the 2026-08-26 noise
incident cannot silently return, keep Terraform and the reconciler Lambda in
agreement, and keep the us-east-2 alert topic subscribed.
"""

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
MONITORING = (ROOT / "terraform/compliance-monitoring/monitoring.tf").read_text()
USE2 = (ROOT / "terraform/compliance-monitoring/use2-security.tf").read_text()
RECONCILER = (
    ROOT / "terraform/compliance-monitoring/functions/alb_alarm_reconciler.py"
).read_text()
RECONCILER_TF = (
    ROOT / "terraform/compliance-monitoring/alb-alarm-reconciler.tf"
).read_text()
LOGGER_TF = (
    ROOT / "terraform/compliance-monitoring/compliance-alerts-logger.tf"
).read_text()

# (prefix, config, ALB discovery local the sibling alarms iterate, SNS action)
REGION_FAMILIES = (
    ("usw2", MONITORING, "local.usw2_albs", "data.aws_sns_topic.usw2_alerts.arn"),
    ("euw2", MONITORING, "local.euw2_albs", "data.aws_sns_topic.euw2_alerts.arn"),
    ("use2", USE2, "local.use2_albs", "aws_sns_topic.use2_alerts.arn"),
)


def block(config, header):
    """Return the text of the block starting at `header` up to its closing brace."""
    start = config.index(header)
    end = config.index("\n}", start)
    return config[start : end + 2]


class AlbTargetResponseTimeAlarmTests(unittest.TestCase):
    def test_every_regional_alb_family_has_a_target_response_time_alarm(self):
        # ALBs are discovered (data.aws_lbs -> local.*_albs) because EKS
        # generates their names, so "every ALB" is enforced by iterating the
        # exact same map the elb-5xx / unhealthy-hosts siblings use.
        for prefix, config, albs_local, topic_arn in REGION_FAMILIES:
            with self.subTest(region=prefix):
                alarm = block(
                    config,
                    f'resource "aws_cloudwatch_metric_alarm" "{prefix}_target_response_time" {{',
                )
                self.assertIn(f"for_each            = {albs_local}", alarm)
                self.assertIn('namespace           = "AWS/ApplicationELB"', alarm)
                self.assertIn('metric_name         = "TargetResponseTime"', alarm)
                self.assertIn(
                    "dimensions          = { LoadBalancer = each.value.dimension }",
                    alarm,
                )
                self.assertIn(f"alarm_actions       = [{topic_arn}]", alarm)

    def test_thresholds_stay_above_by_design_streaming_traffic(self):
        # The 2026-08-26 retirement happened because Average >= 2 s flapped on
        # 6-11 s streaming averages (~300 emails/day). 30 s sustained for three
        # consecutive 5-minute periods sits above the worst 14-day average
        # (~25 s) and only fires on a genuine stall. A regression to the old
        # numbers fails here before it pages anyone.
        for prefix, config, _, _ in REGION_FAMILIES:
            with self.subTest(region=prefix):
                alarm = block(
                    config,
                    f'resource "aws_cloudwatch_metric_alarm" "{prefix}_target_response_time" {{',
                )
                self.assertIn('statistic           = "Average"', alarm)
                self.assertIn("period              = 300", alarm)
                self.assertIn("evaluation_periods  = 3", alarm)
                self.assertIn("datapoints_to_alarm = 3", alarm)
                self.assertIn("threshold           = 30", alarm)
                self.assertIn(
                    'comparison_operator = "GreaterThanThreshold"', alarm
                )
                self.assertIn('treat_missing_data  = "notBreaching"', alarm)

    def test_no_removed_block_unmanages_the_alarm_again(self):
        # A `removed { ... }` block for these addresses would make Terraform
        # forget the family while the config looks fine.
        for prefix, config, _, _ in REGION_FAMILIES:
            with self.subTest(region=prefix):
                self.assertNotIn(
                    f"from = aws_cloudwatch_metric_alarm.{prefix}_target_response_time",
                    config,
                )

    def test_reconciler_repairs_the_same_alarm_family(self):
        # The reconciler rewrites any alarm whose configuration drifts from
        # ALARM_SPECS, so its target-response-time spec must stay identical to
        # the Terraform resources or the two managers fight every 5 minutes.
        spec = block(RECONCILER, '"target-response-time": {')
        self.assertIn('"MetricName": "TargetResponseTime",', spec)
        self.assertIn('"Statistic": "Average",', spec)
        self.assertIn('"Period": 300,', spec)
        self.assertIn('"EvaluationPeriods": 3,', spec)
        self.assertIn('"DatapointsToAlarm": 3,', spec)
        self.assertIn('"Threshold": 30.0,', spec)
        self.assertIn('"ComparisonOperator": "GreaterThanThreshold",', spec)

    def test_every_terraform_managed_alarm_topic_is_subscribed(self):
        # Drata requires hasTopic AND hasSubscription for the alarm's action
        # topic. The us-west-2 and eu-west-2 topics are data sources whose
        # confirmed email subscriptions live outside Terraform (verified
        # 2026-09-17: marko@kortix.com, SubscriptionArn confirmed). The
        # us-east-2 topic is Terraform-managed and had ZERO subscriptions, so
        # its subscription must stay declared here.
        subscription = block(
            USE2,
            'resource "aws_sns_topic_subscription" "use2_alerts_email" {',
        )
        self.assertIn("topic_arn = aws_sns_topic.use2_alerts.arn", subscription)
        self.assertIn('protocol  = "email"', subscription)
        self.assertIn('endpoint  = "marko@kortix.com"', subscription)
        # A pending email subscription still fails Drata's hasSubscription
        # fact (tests 294/296/298, observed 2026-09-18). Lambda-protocol
        # subscriptions are Active immediately on Subscribe, so the use2
        # topic must also declare an auto-confirmed Lambda subscriber or the
        # invariant "the use2 topic always has a confirmed subscriber"
        # depends on a human clicking the SNS confirmation email.
        lambda_subscription = block(
            LOGGER_TF,
            'resource "aws_sns_topic_subscription" "use2_alerts_lambda" {',
        )
        self.assertIn(
            "topic_arn = aws_sns_topic.use2_alerts.arn", lambda_subscription
        )
        self.assertIn('protocol  = "lambda"', lambda_subscription)
        self.assertIn(
            "endpoint  = aws_lambda_function.use2_compliance_alerts_logger.arn",
            lambda_subscription,
        )
        # SNS may invoke the logger only from the use2 alert topic.
        self.assertIn('principal     = "sns.amazonaws.com"', LOGGER_TF)
        self.assertIn(
            "source_arn    = aws_sns_topic.use2_alerts.arn", LOGGER_TF
        )
        # Reconciler-created alarms in every region notify the same topics.
        self.assertIn(
            "ALERT_TOPIC_ARN = aws_sns_topic.use2_alerts.arn", RECONCILER_TF
        )
        self.assertIn(
            "ALERT_TOPIC_ARN = data.aws_sns_topic.usw2_alerts.arn", RECONCILER_TF
        )
        self.assertIn(
            "ALERT_TOPIC_ARN = data.aws_sns_topic.euw2_alerts.arn", RECONCILER_TF
        )


if __name__ == "__main__":
    unittest.main()
