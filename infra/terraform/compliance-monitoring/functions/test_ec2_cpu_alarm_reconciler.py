import unittest

from ec2_cpu_alarm_reconciler import reconcile


class FakePaginator:
    def __init__(self, pages):
        self.pages = pages
        self.filters = None

    def paginate(self, **kwargs):
        self.filters = kwargs["Filters"]
        return self.pages


class FakeEc2:
    def __init__(self, pages):
        self.paginator = FakePaginator(pages)

    def get_paginator(self, operation):
        assert operation == "describe_instances"
        return self.paginator


class FakeCloudWatch:
    def __init__(self, alarms=None):
        self.alarms = alarms or []
        self.describe_calls = []
        self.put_calls = []

    def describe_alarms(self, **kwargs):
        self.describe_calls.append(kwargs)
        names = set(kwargs["AlarmNames"])
        return {
            "MetricAlarms": [
                alarm for alarm in self.alarms if alarm["AlarmName"] in names
            ]
        }

    def put_metric_alarm(self, **kwargs):
        self.put_calls.append(kwargs)


def instance_page(*instance_ids):
    return {
        "Reservations": [
            {"Instances": [{"InstanceId": instance_id} for instance_id in instance_ids]}
        ]
    }


class ReconcilerTest(unittest.TestCase):
    topic = "arn:aws:sns:us-west-2:935064898258:suna-api-alerts"

    def test_creates_a_drata_compatible_alarm_for_every_running_instance(self):
        ec2 = FakeEc2([instance_page("i-b", "i-a"), instance_page("i-a")])
        cloudwatch = FakeCloudWatch()

        result = reconcile(ec2, cloudwatch, self.topic)

        self.assertEqual(result["running_instances"], 2)
        self.assertEqual(result["updated_instances"], ["i-a", "i-b"])
        self.assertEqual(len(cloudwatch.put_calls), 2)
        alarm = cloudwatch.put_calls[0]
        self.assertEqual(alarm["AlarmName"], "compliance-i-a-cpu-high")
        self.assertEqual(alarm["Namespace"], "AWS/EC2")
        self.assertEqual(alarm["MetricName"], "CPUUtilization")
        self.assertEqual(
            alarm["Dimensions"], [{"Name": "InstanceId", "Value": "i-a"}]
        )
        self.assertEqual(alarm["AlarmActions"], [self.topic])
        self.assertEqual(alarm["Threshold"], 80.0)
        self.assertEqual(alarm["Period"], 300)
        self.assertEqual(alarm["EvaluationPeriods"], 3)
        self.assertEqual(alarm["DatapointsToAlarm"], 3)
        self.assertEqual(
            ec2.paginator.filters,
            [{"Name": "instance-state-name", "Values": ["running"]}],
        )

    def test_does_not_rewrite_an_already_compliant_alarm(self):
        existing = {
            "AlarmName": "compliance-i-a-cpu-high",
            "AlarmDescription": "EC2 CPU above 80 percent for 15 minutes",
            "ActionsEnabled": True,
            "AlarmActions": [self.topic],
            "MetricName": "CPUUtilization",
            "Namespace": "AWS/EC2",
            "Statistic": "Average",
            "Dimensions": [{"Value": "i-a", "Name": "InstanceId"}],
            "Period": 300,
            "EvaluationPeriods": 3,
            "DatapointsToAlarm": 3,
            "Threshold": 80.0,
            "ComparisonOperator": "GreaterThanOrEqualToThreshold",
            "TreatMissingData": "notBreaching",
        }
        cloudwatch = FakeCloudWatch([existing])

        result = reconcile(FakeEc2([instance_page("i-a")]), cloudwatch, self.topic)

        self.assertEqual(result["updated_instances"], [])
        self.assertEqual(cloudwatch.put_calls, [])

    def test_repairs_an_alarm_with_no_notification_action(self):
        existing = {
            "AlarmName": "compliance-i-a-cpu-high",
            "AlarmDescription": "EC2 CPU above 80 percent for 15 minutes",
            "ActionsEnabled": True,
            "AlarmActions": [],
            "MetricName": "CPUUtilization",
            "Namespace": "AWS/EC2",
            "Statistic": "Average",
            "Dimensions": [{"Name": "InstanceId", "Value": "i-a"}],
            "Period": 300,
            "EvaluationPeriods": 3,
            "DatapointsToAlarm": 3,
            "Threshold": 80.0,
            "ComparisonOperator": "GreaterThanOrEqualToThreshold",
            "TreatMissingData": "notBreaching",
        }
        cloudwatch = FakeCloudWatch([existing])

        result = reconcile(FakeEc2([instance_page("i-a")]), cloudwatch, self.topic)

        self.assertEqual(result["updated_instances"], ["i-a"])
        self.assertEqual(cloudwatch.put_calls[0]["AlarmActions"], [self.topic])


if __name__ == "__main__":
    unittest.main()
