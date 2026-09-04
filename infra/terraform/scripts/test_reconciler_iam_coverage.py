#!/usr/bin/env python3
"""Every AWS API a compliance reconciler Lambda calls must be granted by its role.

The ALB alarm reconciler called elasticloadbalancing:DescribeTargetGroups from
2026-08-06 and its role only allowed DescribeLoadBalancers. The function raised
AccessDenied on every five-minute tick for 20 days while the schedule stayed
ENABLED. This test reads the boto3 calls out of the Lambda sources and fails
when the IAM policy document in ec2-cpu-reconciler.tf does not name each
matching action.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
STACK = ROOT / "terraform/compliance-monitoring"
POLICY = STACK / "ec2-cpu-reconciler.tf"
FUNCTIONS = sorted(
    path
    for path in (STACK / "functions").glob("*_reconciler.py")
    if not path.name.startswith("test_")
)

# boto3 client name -> IAM service prefix.
SERVICE_PREFIX = {
    "ec2": "ec2",
    "elbv2": "elasticloadbalancing",
    "cloudwatch": "cloudwatch",
}
# Calls that need no IAM action of their own.
NON_API_METHODS = {"get_paginator"}


def _camel(name: str) -> str:
    return "".join(part.capitalize() for part in name.split("_"))


def called_actions(source: str) -> set[str]:
    actions: set[str] = set()
    # <client>.<method>(  and  <client>.get_paginator("<method>")
    for client, method in re.findall(r"\b(\w+)\.(\w+)\(", source):
        if client in SERVICE_PREFIX and method not in NON_API_METHODS:
            actions.add(f"{SERVICE_PREFIX[client]}:{_camel(method)}")
    for client, method in re.findall(
        r"\b(\w+)\.get_paginator\(\"(\w+)\"\)", source
    ):
        if client in SERVICE_PREFIX:
            actions.add(f"{SERVICE_PREFIX[client]}:{_camel(method)}")
    return actions


class ReconcilerIamCoverageTests(unittest.TestCase):
    def test_every_lambda_api_call_is_granted(self):
        policy = POLICY.read_text()
        self.assertTrue(FUNCTIONS, "no reconciler Lambda sources found")
        for path in FUNCTIONS:
            actions = called_actions(path.read_text())
            self.assertTrue(actions, f"{path.name}: no boto3 calls detected")
            for action in sorted(actions):
                with self.subTest(function=path.name, action=action):
                    self.assertTrue(
                        f'"{action}"' in policy,
                        f"{path.name} calls {action} but "
                        f"{POLICY.relative_to(ROOT)} does not grant it",
                    )

    def test_alb_reconciler_detection_sees_the_known_calls(self):
        source = (STACK / "functions/alb_alarm_reconciler.py").read_text()
        actions = called_actions(source)
        for expected in (
            "elasticloadbalancing:DescribeLoadBalancers",
            "elasticloadbalancing:DescribeTargetGroups",
            "cloudwatch:DescribeAlarms",
            "cloudwatch:PutMetricAlarm",
            "cloudwatch:DeleteAlarms",
        ):
            self.assertIn(expected, actions)


if __name__ == "__main__":
    unittest.main()
