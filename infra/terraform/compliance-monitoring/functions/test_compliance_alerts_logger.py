import contextlib
import io
import json
import unittest

from compliance_alerts_logger import lambda_handler

TOPIC = "arn:aws:sns:us-east-2:935064898258:kortix-compliance-alerts"


def notification_record(message):
    return {
        "EventSource": "aws:sns",
        "EventVersion": "1.0",
        "Sns": {
            "TopicArn": TOPIC,
            "Message": message,
            "Subject": "ALARM: \"kortix-alb-kortix-prod-use2-alb-elb-5xx\"",
        },
    }


def logged_lines(stdout):
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


class ComplianceAlertsLoggerTest(unittest.TestCase):
    def test_logs_every_sns_notification_and_reports_success(self):
        alarm = (
            '{"AlarmName":"kortix-alb-kortix-prod-use2-alb-elb-5xx",'
            '"NewStateValue":"ALARM","Region":"US East (Ohio)"}'
        )
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            result = lambda_handler(
                {"Records": [notification_record(alarm)] * 2}, None
            )

        self.assertEqual(result, "logged")
        records = logged_lines(stdout)
        self.assertEqual(len(records), 2)
        for record in records:
            self.assertEqual(record["Sns"]["TopicArn"], TOPIC)
            self.assertIn("ALARM", record["Sns"]["Message"])

    def test_logs_subscription_confirmation_without_raising(self):
        # Subscribe sends a SubscriptionConfirmation to the Lambda endpoint;
        # logging it verbatim must not be treated as a delivery failure.
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            result = lambda_handler(
                {
                    "Records": [
                        notification_record(
                            '{"Type":"SubscriptionConfirmation",'
                            '"SubscribeURL":"https://sns.us-east-2.amazonaws.com/'
                            '?Action=ConfirmSubscription&TopicArn='
                            + TOPIC + '"}'
                        )
                    ]
                },
                None,
            )

        self.assertEqual(result, "logged")
        record = logged_lines(stdout)[0]
        self.assertIn("SubscriptionConfirmation", record["Sns"]["Message"])

    def test_never_raises_on_unexpected_event_shapes(self):
        for event in ({}, {"Records": []}, {"Records": [{}], "X": 1}):
            with self.subTest(event=event):
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    result = lambda_handler(event, None)
                self.assertEqual(result, "logged")


if __name__ == "__main__":
    unittest.main()
