import unittest

from alb_alarm_reconciler import ALARM_SPECS, reconcile


class FakePaginator:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def paginate(self, **kwargs):
        self.calls.append(kwargs)
        return self.pages


class FakeElbv2:
    def __init__(self, pages):
        self.paginator = FakePaginator(pages)

    def get_paginator(self, operation):
        assert operation == "describe_load_balancers"
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


def load_balancer(name, identifier, load_balancer_type="application"):
    return {
        "LoadBalancerName": name,
        "LoadBalancerArn": (
            "arn:aws:elasticloadbalancing:us-west-2:935064898258:"
            f"loadbalancer/{identifier}"
        ),
        "Type": load_balancer_type,
    }


class ReconcilerTest(unittest.TestCase):
    topic = "arn:aws:sns:us-west-2:935064898258:suna-api-alerts"

    def test_creates_three_drata_compatible_alarms_for_each_application_lb(self):
        elbv2 = FakeElbv2(
            [
                {
                    "LoadBalancers": [
                        load_balancer("b", "app/b/b-id"),
                        load_balancer("ignored", "net/ignored/id", "network"),
                    ]
                },
                {"LoadBalancers": [load_balancer("a", "app/a/a-id")]},
            ]
        )
        cloudwatch = FakeCloudWatch()

        result = reconcile(elbv2, cloudwatch, self.topic)

        self.assertEqual(result["load_balancers"], 2)
        self.assertEqual(result["covered_alarms"], 6)
        self.assertEqual(len(result["updated_alarms"]), 6)
        self.assertEqual(len(cloudwatch.put_calls), 6)
        target_alarm = next(
            alarm
            for alarm in cloudwatch.put_calls
            if alarm["AlarmName"] == "kortix-alb-a-target-response-time"
        )
        self.assertEqual(target_alarm["Namespace"], "AWS/ApplicationELB")
        self.assertEqual(target_alarm["MetricName"], "TargetResponseTime")
        self.assertEqual(
            target_alarm["Dimensions"],
            [{"Name": "LoadBalancer", "Value": "app/a/a-id"}],
        )
        self.assertEqual(target_alarm["AlarmActions"], [self.topic])
        self.assertEqual(target_alarm["TreatMissingData"], "notBreaching")
        self.assertEqual(set(ALARM_SPECS), {
            "target-response-time",
            "elb-5xx",
            "unhealthy-hosts",
        })

    def test_does_not_rewrite_compliant_alarms(self):
        lb = load_balancer("a", "app/a/a-id")
        first_cloudwatch = FakeCloudWatch()
        reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), first_cloudwatch, self.topic)
        cloudwatch = FakeCloudWatch(first_cloudwatch.put_calls)

        result = reconcile(
            FakeElbv2([{"LoadBalancers": [lb]}]), cloudwatch, self.topic
        )

        self.assertEqual(result["updated_alarms"], [])
        self.assertEqual(cloudwatch.put_calls, [])

    def test_repairs_stale_dimensions_and_missing_notification_actions(self):
        lb = load_balancer("previews", "app/previews/new-id")
        first_cloudwatch = FakeCloudWatch()
        reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), first_cloudwatch, self.topic)
        alarms = first_cloudwatch.put_calls
        alarms[0]["Dimensions"] = [
            {"Name": "LoadBalancer", "Value": "app/previews/old-id"}
        ]
        alarms[1]["AlarmActions"] = []
        cloudwatch = FakeCloudWatch(alarms)

        result = reconcile(
            FakeElbv2([{"LoadBalancers": [lb]}]), cloudwatch, self.topic
        )

        self.assertEqual(
            result["updated_alarms"],
            [
                "kortix-alb-previews-target-response-time",
                "kortix-alb-previews-elb-5xx",
            ],
        )
        self.assertEqual(len(cloudwatch.put_calls), 2)
        self.assertEqual(
            cloudwatch.put_calls[0]["Dimensions"],
            [{"Name": "LoadBalancer", "Value": "app/previews/new-id"}],
        )
        self.assertEqual(cloudwatch.put_calls[1]["AlarmActions"], [self.topic])


if __name__ == "__main__":
    unittest.main()
