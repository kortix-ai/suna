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
    def __init__(self, pages, target_groups=None):
        self.paginator = FakePaginator(pages)
        self.target_groups = target_groups or {
            load_balancer["LoadBalancerArn"]: [
                target_group(
                    f"{load_balancer['LoadBalancerName']}-tg",
                    f"{load_balancer['LoadBalancerName']}-tg-id",
                )
            ]
            for page in pages
            for load_balancer in page.get("LoadBalancers", [])
            if load_balancer.get("Type") == "application"
        }

    def get_paginator(self, operation):
        assert operation == "describe_load_balancers"
        return self.paginator

    def describe_target_groups(self, **kwargs):
        return {"TargetGroups": self.target_groups.get(kwargs["LoadBalancerArn"], [])}


class FakeCloudWatch:
    def __init__(self, alarms=None):
        self.alarms = alarms or []
        self.describe_calls = []
        self.put_calls = []
        self.delete_calls = []

    def describe_alarms(self, **kwargs):
        self.describe_calls.append(kwargs)
        names = set(kwargs["AlarmNames"])
        return {
            "MetricAlarms": [
                alarm for alarm in self.alarms if alarm["AlarmName"] in names
            ]
        }

    def get_paginator(self, operation):
        assert operation == "describe_alarms"
        return FakeAlarmPaginator(self)

    def put_metric_alarm(self, **kwargs):
        self.put_calls.append(kwargs)

    def delete_alarms(self, **kwargs):
        self.delete_calls.append(kwargs)
        names = set(kwargs["AlarmNames"])
        self.alarms = [alarm for alarm in self.alarms if alarm["AlarmName"] not in names]


class FakeAlarmPaginator:
    def __init__(self, cloudwatch):
        self.cloudwatch = cloudwatch

    def paginate(self, **kwargs):
        assert kwargs["AlarmTypes"] == ["MetricAlarm"]
        prefix = kwargs["AlarmNamePrefix"]
        matching = [
            alarm
            for alarm in self.cloudwatch.alarms
            if alarm["AlarmName"].startswith(prefix)
        ]
        # Two pages so the reconciler proves it walks the paginator.
        return [{"MetricAlarms": matching[:1]}, {"MetricAlarms": matching[1:]}]


def legacy_alb_alarm(name, namespace="AWS/ApplicationELB"):
    return {
        "AlarmName": name,
        "Namespace": namespace,
        "MetricName": "TargetResponseTime",
        "Dimensions": [{"Name": "LoadBalancer", "Value": "app/legacy/legacy-id"}],
    }


def load_balancer(name, identifier, load_balancer_type="application"):
    return {
        "LoadBalancerName": name,
        "LoadBalancerArn": (
            "arn:aws:elasticloadbalancing:us-west-2:935064898258:"
            f"loadbalancer/{identifier}"
        ),
        "Type": load_balancer_type,
    }


def target_group(name, identifier):
    return {
        "TargetGroupName": name,
        "TargetGroupArn": (
            "arn:aws:elasticloadbalancing:us-west-2:935064898258:"
            f"targetgroup/{name}/{identifier}"
        ),
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
        self.assertEqual(result["deleted_alarms"], [])
        self.assertEqual(cloudwatch.delete_calls, [])
        unhealthy_alarm = next(
            alarm
            for alarm in cloudwatch.put_calls
            if alarm["AlarmName"] == "kortix-alb-a-unhealthy-hosts"
        )
        self.assertEqual(unhealthy_alarm["Namespace"], "AWS/ApplicationELB")
        self.assertEqual(unhealthy_alarm["MetricName"], "UnHealthyHostCount")
        self.assertEqual(
            unhealthy_alarm["Dimensions"],
            [
                {"Name": "TargetGroup", "Value": "targetgroup/a-tg/a-tg-id"},
                {"Name": "LoadBalancer", "Value": "app/a/a-id"},
            ],
        )
        self.assertEqual(unhealthy_alarm["AlarmActions"], [self.topic])
        self.assertEqual(unhealthy_alarm["TreatMissingData"], "notBreaching")
        self.assertEqual(
            set(ALARM_SPECS),
            {"elb-5xx", "unhealthy-hosts", "zero-healthy-hosts"},
        )
        self.assertFalse(
            any(spec["MetricName"] == "TargetResponseTime" for spec in ALARM_SPECS.values())
        )
        zero_healthy_alarm = next(
            alarm
            for alarm in cloudwatch.put_calls
            if alarm["AlarmName"] == "kortix-alb-a-zero-healthy-hosts"
        )
        self.assertEqual(zero_healthy_alarm["MetricName"], "HealthyHostCount")
        self.assertEqual(zero_healthy_alarm["Statistic"], "Minimum")
        self.assertEqual(zero_healthy_alarm["Period"], 60)
        self.assertEqual(zero_healthy_alarm["ComparisonOperator"], "LessThanThreshold")
        self.assertEqual(
            zero_healthy_alarm["Dimensions"],
            [
                {"Name": "TargetGroup", "Value": "targetgroup/a-tg/a-tg-id"},
                {"Name": "LoadBalancer", "Value": "app/a/a-id"},
            ],
        )

    def test_creates_distinct_target_alarms_for_multiple_target_groups(self):
        lb = load_balancer("a", "app/a/a-id")
        elbv2 = FakeElbv2(
            [{"LoadBalancers": [lb]}],
            {
                lb["LoadBalancerArn"]: [
                    target_group("blue", "blue-id"),
                    target_group("green", "green-id"),
                ]
            },
        )
        cloudwatch = FakeCloudWatch()

        result = reconcile(elbv2, cloudwatch, self.topic)

        self.assertEqual(result["covered_alarms"], 5)
        self.assertEqual(
            set(result["updated_alarms"]),
            {
                "kortix-alb-a-elb-5xx",
                "kortix-alb-a-blue-unhealthy-hosts",
                "kortix-alb-a-blue-zero-healthy-hosts",
                "kortix-alb-a-green-unhealthy-hosts",
                "kortix-alb-a-green-zero-healthy-hosts",
            },
        )

    def test_does_not_rewrite_compliant_alarms(self):
        lb = load_balancer("a", "app/a/a-id")
        first_cloudwatch = FakeCloudWatch()
        reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), first_cloudwatch, self.topic)
        cloudwatch = FakeCloudWatch(first_cloudwatch.put_calls)

        result = reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), cloudwatch, self.topic)

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

        result = reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), cloudwatch, self.topic)

        self.assertEqual(
            result["updated_alarms"],
            [
                "kortix-alb-previews-elb-5xx",
                "kortix-alb-previews-unhealthy-hosts",
            ],
        )
        self.assertEqual(len(cloudwatch.put_calls), 2)
        self.assertEqual(
            cloudwatch.put_calls[0]["Dimensions"],
            [{"Name": "LoadBalancer", "Value": "app/previews/new-id"}],
        )
        self.assertEqual(cloudwatch.put_calls[1]["AlarmActions"], [self.topic])
        self.assertEqual(
            cloudwatch.put_calls[1]["Dimensions"],
            [
                {
                    "Name": "TargetGroup",
                    "Value": "targetgroup/previews-tg/previews-tg-id",
                },
                {"Name": "LoadBalancer", "Value": "app/previews/new-id"},
            ],
        )

    def test_deletes_retired_target_response_time_alarms_it_created(self):
        lb = load_balancer("a", "app/a/a-id")
        first_cloudwatch = FakeCloudWatch()
        reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), first_cloudwatch, self.topic)
        alarms = first_cloudwatch.put_calls + [
            # Terraform's single-target-group name and the reconciler's
            # per-target-group variants from a blue/green ALB.
            legacy_alb_alarm("kortix-alb-a-target-response-time"),
            legacy_alb_alarm("kortix-alb-a-blue-target-response-time"),
            legacy_alb_alarm("kortix-alb-a-green-target-response-time"),
        ]
        cloudwatch = FakeCloudWatch(alarms)

        result = reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), cloudwatch, self.topic)

        self.assertEqual(result["updated_alarms"], [])
        self.assertEqual(
            result["deleted_alarms"],
            [
                "kortix-alb-a-blue-target-response-time",
                "kortix-alb-a-green-target-response-time",
                "kortix-alb-a-target-response-time",
            ],
        )
        self.assertEqual(len(cloudwatch.delete_calls), 1)
        self.assertEqual(
            sorted(cloudwatch.delete_calls[0]["AlarmNames"]),
            result["deleted_alarms"],
        )
        self.assertEqual(
            sorted(alarm["AlarmName"] for alarm in cloudwatch.alarms),
            [
                "kortix-alb-a-elb-5xx",
                "kortix-alb-a-unhealthy-hosts",
                "kortix-alb-a-zero-healthy-hosts",
            ],
        )

    def test_deletes_legacy_compliance_alb_alarms_but_not_cpu_alarms(self):
        lb = load_balancer("a", "app/a/a-id")
        first_cloudwatch = FakeCloudWatch()
        reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), first_cloudwatch, self.topic)
        cloudwatch = FakeCloudWatch(
            first_cloudwatch.put_calls
            + [
                legacy_alb_alarm("compliance-kortix-prod-gateway-alb-response-time"),
                legacy_alb_alarm("compliance-kortix-prod-alb-elb-5xx"),
                legacy_alb_alarm("compliance-k8s-kortixpr-b24c15d61b-unhealthy-hosts"),
                legacy_alb_alarm("compliance-i-0abc-cpu-high", namespace="AWS/EC2"),
            ]
        )

        result = reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), cloudwatch, self.topic)

        self.assertEqual(result["updated_alarms"], [])
        self.assertEqual(
            result["deleted_alarms"],
            [
                "compliance-k8s-kortixpr-b24c15d61b-unhealthy-hosts",
                "compliance-kortix-prod-alb-elb-5xx",
                "compliance-kortix-prod-gateway-alb-response-time",
            ],
        )
        self.assertIn(
            "compliance-i-0abc-cpu-high",
            [alarm["AlarmName"] for alarm in cloudwatch.alarms],
        )

    def test_never_deletes_a_desired_alarm(self):
        lb = load_balancer("a", "app/a/a-id")
        first_cloudwatch = FakeCloudWatch()
        reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), first_cloudwatch, self.topic)
        cloudwatch = FakeCloudWatch(first_cloudwatch.put_calls)

        result = reconcile(FakeElbv2([{"LoadBalancers": [lb]}]), cloudwatch, self.topic)

        self.assertEqual(result["deleted_alarms"], [])
        self.assertEqual(cloudwatch.delete_calls, [])
        self.assertEqual(len(cloudwatch.alarms), 3)


if __name__ == "__main__":
    unittest.main()
