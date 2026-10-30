#!/usr/bin/env python3
"""Regression test: Drata test 115 (DCF-86) SQS message-age alarm coverage.

Drata test 115 ("Messaging Queue Message Age Monitored") fails a SQS queue
that has no CloudWatch alarm on `ApproximateAgeOfOldestMessage` notifying a
subscribed SNS topic. The alarms live in the compliance-monitoring root while
the queues live in the environment roots (module `capture_store`), because the
AWS provider has no SQS discovery data source to mirror `data.aws_lbs`. The
alarm literals and the queue names the environment roots compose are one
copyable fact; these tests keep them in agreement.
"""

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
USE2 = (ROOT / "terraform/compliance-monitoring/use2-security.tf").read_text()
MODULE = (ROOT / "terraform/modules/capture-store/main.tf").read_text()
DEV = (ROOT / "terraform/environments/dev-us-east-2/main.tf").read_text()

# (manifest queue name, alarm-name stem) of the dev-us-east-2 capture-store
# queues. Module `capture_store` composes both names from the caller's `name`;
# test_module_composes_the_alarmed_names keeps that chain exact.
QUEUES = (
    ("kortix-dev-use2-capture-store-manifests", "manifests"),
    ("kortix-dev-use2-capture-store-manifests-dlq", "manifests-dlq"),
)


def block(config, header):
    """Return the text of the block starting at `header` up to its closing brace."""
    start = config.index(header)
    end = config.index("\n}", start)
    return config[start : end + 2]


class SqsMessageAgeAlarmTests(unittest.TestCase):
    def test_both_dev_manifest_queues_have_a_message_age_alarm(self):
        # Drata flags every queue without the alarm; both queues of the
        # module's dev instantiation must stay covered, DLQ included. One
        # for_each alarm reads local.use2_sqs_queues, whose keys are the two
        # queue names and whose block dimensions the queue via each.key.
        self.assertIn(
            'resource "aws_cloudwatch_metric_alarm" '
            '"use2_sqs_oldest_message_age" {',
            USE2,
            "use2-security.tf lost the SQS message-age alarm block",
        )
        alarm = block(
            USE2,
            'resource "aws_cloudwatch_metric_alarm" "use2_sqs_oldest_message_age" {',
        )
        self.assertIn("provider            = aws.use2", alarm)
        self.assertIn("for_each            = local.use2_sqs_queues", alarm)
        self.assertIn('namespace           = "AWS/SQS"', alarm)
        self.assertIn(
            'metric_name         = "ApproximateAgeOfOldestMessage"', alarm
        )
        self.assertIn("dimensions          = { QueueName = each.key }", alarm)
        self.assertIn(
            "alarm_actions       = [aws_sns_topic.use2_alerts.arn]", alarm
        )
        self.assertIn("tags                = local.alarm_tags", alarm)
        for queue, stem in QUEUES:
            with self.subTest(queue=queue):
                self.assertRegex(
                    USE2,
                    rf'"{queue}"[ \t]+[=] "{stem}"',
                    f"use2-sqs-queues locals lost the {queue} = {stem} entry",
                )

    def test_module_composes_the_alarmed_names(self):
        # The alarm literals repeat queue names another root builds. If the
        # module, the dev caller, or the dev local.name changes, the alarm
        # dimension reads no data and the coverage silently disappears.
        # Composed: local.name "kortix-dev-use2" + "-capture-store" + the
        # module's "-manifests[-dlq]" = both QUEUES names.
        self.assertIn('name                       = "${var.name}-manifests"', MODULE)
        self.assertIn(
            'name                      = "${var.name}-manifests-dlq"', MODULE
        )
        self.assertIn('name              = "${local.name}-capture-store"', DEV)
        self.assertIn('name = "kortix-dev-use2"', DEV)

    def test_alarm_thresholds_fire_on_a_sustained_stall(self):
        # Manifest events normally ingest in seconds (the leader long-polls
        # the queue continuously). A stall alerts only once the oldest
        # message has waited 15 minutes for three consecutive 5-minute
        # periods, above any deploy blip; Maximum cannot average a spike
        # away. An empty queue publishes no series, so
        # treat_missing_data = notBreaching keeps it green.
        alarm = block(
            USE2,
            'resource "aws_cloudwatch_metric_alarm" "use2_sqs_oldest_message_age" {',
        )
        self.assertIn('statistic           = "Maximum"', alarm)
        self.assertIn("period              = 300", alarm)
        self.assertIn("evaluation_periods  = 3", alarm)
        self.assertIn("datapoints_to_alarm = 3", alarm)
        self.assertIn("threshold           = 900", alarm)
        self.assertIn(
            'comparison_operator = "GreaterThanOrEqualToThreshold"', alarm
        )
        self.assertIn('treat_missing_data  = "notBreaching"', alarm)

    def test_no_removed_block_unmanages_the_family_again(self):
        # A `removed { ... }` block for this address would make Terraform
        # forget the family while the config looks fine.
        self.assertNotIn(
            "from = aws_cloudwatch_metric_alarm.use2_sqs_oldest_message_age",
            USE2,
        )


if __name__ == "__main__":
    unittest.main()
