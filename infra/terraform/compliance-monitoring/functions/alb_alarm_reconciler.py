"""Keep every application load balancer covered by the DCF-86 alarms."""

from __future__ import annotations

import os
from collections.abc import Iterable
from typing import Any

ALARM_PREFIX = "kortix-alb-"

ALARM_SPECS: dict[str, dict[str, Any]] = {
    "target-response-time": {
        "AlarmDescription": "SOC2 DCF-86: ALB target response time is elevated",
        "MetricName": "TargetResponseTime",
        "Statistic": "Average",
        "Period": 300,
        "EvaluationPeriods": 2,
        "DatapointsToAlarm": 2,
        "Threshold": 2.0,
        "ComparisonOperator": "GreaterThanThreshold",
    },
    "elb-5xx": {
        "AlarmDescription": "SOC2 DCF-86: ALB server errors detected",
        "MetricName": "HTTPCode_ELB_5XX_Count",
        "Statistic": "Sum",
        "Period": 300,
        "EvaluationPeriods": 1,
        "DatapointsToAlarm": 1,
        "Threshold": 5.0,
        "ComparisonOperator": "GreaterThanOrEqualToThreshold",
    },
    "unhealthy-hosts": {
        "AlarmDescription": "SOC2 DCF-86: ALB has unhealthy targets",
        "MetricName": "UnHealthyHostCount",
        "Statistic": "Maximum",
        "Period": 300,
        "EvaluationPeriods": 2,
        "DatapointsToAlarm": 2,
        "Threshold": 1.0,
        "ComparisonOperator": "GreaterThanOrEqualToThreshold",
    },
}


def _chunks(values: list[str], size: int = 100) -> Iterable[list[str]]:
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]


def _load_balancers(elbv2: Any) -> list[dict[str, str]]:
    load_balancers: dict[str, dict[str, str]] = {}
    paginator = elbv2.get_paginator("describe_load_balancers")
    for page in paginator.paginate():
        for load_balancer in page.get("LoadBalancers", []):
            if load_balancer.get("Type") != "application":
                continue
            arn = load_balancer["LoadBalancerArn"]
            load_balancers[arn] = {
                "name": load_balancer["LoadBalancerName"],
                "dimension": arn.split(":loadbalancer/", 1)[1],
            }
    return [load_balancers[arn] for arn in sorted(load_balancers)]


def _alarm_name(load_balancer_name: str, suffix: str) -> str:
    return f"{ALARM_PREFIX}{load_balancer_name}-{suffix}"


def _alarm_configuration(
    load_balancer: dict[str, str], suffix: str, topic_arn: str
) -> dict[str, Any]:
    return {
        "AlarmName": _alarm_name(load_balancer["name"], suffix),
        **ALARM_SPECS[suffix],
        "ActionsEnabled": True,
        "AlarmActions": [topic_arn],
        "Namespace": "AWS/ApplicationELB",
        "Dimensions": [
            {"Name": "LoadBalancer", "Value": load_balancer["dimension"]}
        ],
        "TreatMissingData": "notBreaching",
        "Tags": [
            {"Key": "ManagedBy", "Value": "kortix-compliance"},
            {"Key": "Control", "Value": "DCF-86"},
        ],
    }


def _is_compliant(
    alarm: dict[str, Any],
    load_balancer: dict[str, str],
    suffix: str,
    topic_arn: str,
) -> bool:
    expected = _alarm_configuration(load_balancer, suffix, topic_arn)
    scalar_fields = (
        "AlarmDescription",
        "ActionsEnabled",
        "MetricName",
        "Namespace",
        "Statistic",
        "Period",
        "EvaluationPeriods",
        "DatapointsToAlarm",
        "Threshold",
        "ComparisonOperator",
        "TreatMissingData",
    )
    if any(alarm.get(field) != expected[field] for field in scalar_fields):
        return False

    dimensions = {
        (dimension.get("Name"), dimension.get("Value"))
        for dimension in alarm.get("Dimensions", [])
    }
    expected_dimensions = {
        (dimension["Name"], dimension["Value"])
        for dimension in expected["Dimensions"]
    }
    return dimensions == expected_dimensions and alarm.get("AlarmActions", []) == [
        topic_arn
    ]


def reconcile(elbv2: Any, cloudwatch: Any, topic_arn: str) -> dict[str, Any]:
    load_balancers = _load_balancers(elbv2)
    desired = [
        (load_balancer, suffix)
        for load_balancer in load_balancers
        for suffix in ALARM_SPECS
    ]
    alarm_names = [
        _alarm_name(load_balancer["name"], suffix)
        for load_balancer, suffix in desired
    ]
    existing: dict[str, dict[str, Any]] = {}

    for names in _chunks(alarm_names):
        response = cloudwatch.describe_alarms(AlarmNames=names)
        existing.update(
            {alarm["AlarmName"]: alarm for alarm in response.get("MetricAlarms", [])}
        )

    updated: list[str] = []
    for load_balancer, suffix in desired:
        name = _alarm_name(load_balancer["name"], suffix)
        if not _is_compliant(
            existing.get(name, {}), load_balancer, suffix, topic_arn
        ):
            cloudwatch.put_metric_alarm(
                **_alarm_configuration(load_balancer, suffix, topic_arn)
            )
            updated.append(name)

    result = {
        "load_balancers": len(load_balancers),
        "covered_alarms": len(desired),
        "updated_alarms": updated,
    }
    print(result)
    return result


def lambda_handler(_event: dict[str, Any], _context: Any) -> dict[str, Any]:
    import boto3

    region = os.environ["AWS_REGION"]
    return reconcile(
        boto3.client("elbv2", region_name=region),
        boto3.client("cloudwatch", region_name=region),
        os.environ["ALERT_TOPIC_ARN"],
    )
