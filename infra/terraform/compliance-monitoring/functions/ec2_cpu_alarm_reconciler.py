"""Keep every running EC2 instance covered by the DCF-86 CPU alarm."""

from __future__ import annotations

import os
from collections.abc import Iterable
from typing import Any

ALARM_PREFIX = "compliance-"
ALARM_SUFFIX = "-cpu-high"


def _chunks(values: list[str], size: int = 100) -> Iterable[list[str]]:
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]


def _running_instance_ids(ec2: Any) -> list[str]:
    instance_ids: list[str] = []
    paginator = ec2.get_paginator("describe_instances")
    for page in paginator.paginate(
        Filters=[{"Name": "instance-state-name", "Values": ["running"]}]
    ):
        for reservation in page.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                instance_ids.append(instance["InstanceId"])
    return sorted(set(instance_ids))


def _alarm_name(instance_id: str) -> str:
    return f"{ALARM_PREFIX}{instance_id}{ALARM_SUFFIX}"


def _alarm_configuration(instance_id: str, topic_arn: str) -> dict[str, Any]:
    return {
        "AlarmName": _alarm_name(instance_id),
        "AlarmDescription": "EC2 CPU above 80 percent for 15 minutes",
        "ActionsEnabled": True,
        "AlarmActions": [topic_arn],
        "MetricName": "CPUUtilization",
        "Namespace": "AWS/EC2",
        "Statistic": "Average",
        "Dimensions": [{"Name": "InstanceId", "Value": instance_id}],
        "Period": 300,
        "EvaluationPeriods": 3,
        "DatapointsToAlarm": 3,
        "Threshold": 80.0,
        "ComparisonOperator": "GreaterThanOrEqualToThreshold",
        "TreatMissingData": "notBreaching",
        "Tags": [
            {"Key": "ManagedBy", "Value": "kortix-compliance"},
            {"Key": "Control", "Value": "DCF-86"},
        ],
    }


def _is_compliant(alarm: dict[str, Any], instance_id: str, topic_arn: str) -> bool:
    expected = _alarm_configuration(instance_id, topic_arn)
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


def reconcile(ec2: Any, cloudwatch: Any, topic_arn: str) -> dict[str, Any]:
    instance_ids = _running_instance_ids(ec2)
    alarm_names = [_alarm_name(instance_id) for instance_id in instance_ids]
    existing: dict[str, dict[str, Any]] = {}

    for names in _chunks(alarm_names):
        response = cloudwatch.describe_alarms(AlarmNames=names)
        existing.update(
            {alarm["AlarmName"]: alarm for alarm in response.get("MetricAlarms", [])}
        )

    updated: list[str] = []
    for instance_id in instance_ids:
        name = _alarm_name(instance_id)
        if not _is_compliant(existing.get(name, {}), instance_id, topic_arn):
            cloudwatch.put_metric_alarm(
                **_alarm_configuration(instance_id, topic_arn)
            )
            updated.append(instance_id)

    result = {
        "running_instances": len(instance_ids),
        "covered_instances": len(instance_ids),
        "updated_instances": updated,
    }
    print(result)
    return result


def lambda_handler(_event: dict[str, Any], _context: Any) -> dict[str, Any]:
    import boto3

    region = os.environ["AWS_REGION"]
    return reconcile(
        boto3.client("ec2", region_name=region),
        boto3.client("cloudwatch", region_name=region),
        os.environ["ALERT_TOPIC_ARN"],
    )
