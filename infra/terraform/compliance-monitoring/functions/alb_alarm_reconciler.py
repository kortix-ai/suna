"""Keep every application load balancer covered by the DCF-86 alarms."""

from __future__ import annotations

import os
from collections.abc import Iterable
from typing import Any

ALARM_PREFIX = "kortix-alb-"
ALARM_NAMESPACE = "AWS/ApplicationELB"
TARGET_GROUP_METRICS = {
    "unhealthy-hosts",
    "zero-healthy-hosts",
}

# Alarm suffixes this reconciler used to own and now deletes on every run.
#
# "target-response-time" alarmed on average TargetResponseTime >= 2 s. The
# gateway ALB streams LLM completions and the API ALB holds SSE streams, so a
# 6-11 s average is normal traffic there. The alarm flapped ALARM/OK every
# 5-10 minutes and produced ~300 SNS emails in one day (2026-08-26) without
# one real incident. Availability is still covered by elb-5xx,
# unhealthy-hosts, and zero-healthy-hosts.
RETIRED_ALARM_SUFFIXES = ("-target-response-time",)

# Hand-made ALB alarms from the 2026-07-27 compliance evidence pass. They
# duplicate the kortix-alb-* set on the same load balancers and are not in
# Terraform. Only alarms in the ALB namespace match; compliance-*-cpu-high
# alarms live in AWS/EC2 and belong to the EC2 reconciler.
LEGACY_ALARM_PREFIX = "compliance-"

ALARM_SPECS: dict[str, dict[str, Any]] = {
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
    "zero-healthy-hosts": {
        "AlarmDescription": "SOC2 DCF-86: ALB has zero healthy targets",
        "MetricName": "HealthyHostCount",
        "Statistic": "Minimum",
        "Period": 60,
        "EvaluationPeriods": 2,
        "DatapointsToAlarm": 2,
        "Threshold": 1.0,
        "ComparisonOperator": "LessThanThreshold",
    },
}


def _chunks(values: list[str], size: int = 100) -> Iterable[list[str]]:
    for offset in range(0, len(values), size):
        yield values[offset : offset + size]


def _load_balancers(elbv2: Any) -> list[dict[str, Any]]:
    load_balancers: dict[str, dict[str, Any]] = {}
    paginator = elbv2.get_paginator("describe_load_balancers")
    for page in paginator.paginate():
        for load_balancer in page.get("LoadBalancers", []):
            if load_balancer.get("Type") != "application":
                continue
            arn = load_balancer["LoadBalancerArn"]
            target_groups = elbv2.describe_target_groups(LoadBalancerArn=arn).get(
                "TargetGroups", []
            )
            load_balancers[arn] = {
                "name": load_balancer["LoadBalancerName"],
                "dimension": arn.split(":loadbalancer/", 1)[1],
                "target_groups": [
                    {
                        "name": target_group["TargetGroupName"],
                        "dimension": target_group["TargetGroupArn"].split(":", 5)[5],
                    }
                    for target_group in sorted(
                        target_groups,
                        key=lambda target_group: target_group["TargetGroupArn"],
                    )
                ],
            }
    return [load_balancers[arn] for arn in sorted(load_balancers)]


def _alarm_name(
    load_balancer_name: str,
    suffix: str,
    target_group: dict[str, str] | None = None,
    target_group_count: int = 1,
) -> str:
    target_group_segment = (
        f"-{target_group['name']}"
        if target_group is not None and target_group_count > 1
        else ""
    )
    return f"{ALARM_PREFIX}{load_balancer_name}{target_group_segment}-{suffix}"


def _alarm_configuration(
    load_balancer: dict[str, Any],
    suffix: str,
    topic_arn: str,
    target_group: dict[str, str] | None = None,
) -> dict[str, Any]:
    dimensions = [{"Name": "LoadBalancer", "Value": load_balancer["dimension"]}]
    if suffix in TARGET_GROUP_METRICS:
        if target_group is None:
            raise ValueError(f"{suffix} requires a target group")
        dimensions.insert(
            0,
            {"Name": "TargetGroup", "Value": target_group["dimension"]},
        )
    return {
        "AlarmName": _alarm_name(
            load_balancer["name"],
            suffix,
            target_group,
            len(load_balancer["target_groups"]),
        ),
        **ALARM_SPECS[suffix],
        "ActionsEnabled": True,
        "AlarmActions": [topic_arn],
        "Namespace": ALARM_NAMESPACE,
        "Dimensions": dimensions,
        "TreatMissingData": "notBreaching",
        "Tags": [
            {"Key": "ManagedBy", "Value": "kortix-compliance"},
            {"Key": "Control", "Value": "DCF-86"},
        ],
    }


def _is_compliant(
    alarm: dict[str, Any],
    load_balancer: dict[str, Any],
    suffix: str,
    topic_arn: str,
    target_group: dict[str, str] | None = None,
) -> bool:
    expected = _alarm_configuration(load_balancer, suffix, topic_arn, target_group)
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
        (dimension["Name"], dimension["Value"]) for dimension in expected["Dimensions"]
    }
    return dimensions == expected_dimensions and alarm.get("AlarmActions", []) == [
        topic_arn
    ]


def _alarms_with_prefix(cloudwatch: Any, prefix: str) -> list[dict[str, Any]]:
    alarms: list[dict[str, Any]] = []
    paginator = cloudwatch.get_paginator("describe_alarms")
    for page in paginator.paginate(AlarmNamePrefix=prefix, AlarmTypes=["MetricAlarm"]):
        alarms.extend(page.get("MetricAlarms", []))
    return alarms


def _stale_alarm_names(cloudwatch: Any, desired_names: set[str]) -> list[str]:
    """Alarms this reconciler owns that no longer belong in the account.

    Two families qualify:

    - kortix-alb-* alarms whose suffix is retired. Terraform only ever managed
      the single-target-group name; the per-target-group variants
      (kortix-alb-<lb>-<tg>-target-response-time) were created by this
      function alone, so only this function can remove them.
    - compliance-* alarms in the ALB namespace. They are unmanaged duplicates
      of the kortix-alb-* coverage.

    Any name in `desired_names` is never stale.
    """
    stale: set[str] = set()
    for alarm in _alarms_with_prefix(cloudwatch, ALARM_PREFIX):
        name = alarm["AlarmName"]
        if name in desired_names:
            continue
        if name.endswith(RETIRED_ALARM_SUFFIXES):
            stale.add(name)
    for alarm in _alarms_with_prefix(cloudwatch, LEGACY_ALARM_PREFIX):
        if alarm.get("Namespace") == ALARM_NAMESPACE:
            stale.add(alarm["AlarmName"])
    return sorted(stale)


def reconcile(elbv2: Any, cloudwatch: Any, topic_arn: str) -> dict[str, Any]:
    load_balancers = _load_balancers(elbv2)
    desired: list[tuple[dict[str, Any], str, dict[str, str] | None]] = []
    for load_balancer in load_balancers:
        for suffix in ALARM_SPECS:
            if suffix in TARGET_GROUP_METRICS:
                desired.extend(
                    (load_balancer, suffix, target_group)
                    for target_group in load_balancer["target_groups"]
                )
            else:
                desired.append((load_balancer, suffix, None))
    alarm_names = [
        _alarm_name(
            load_balancer["name"],
            suffix,
            target_group,
            len(load_balancer["target_groups"]),
        )
        for load_balancer, suffix, target_group in desired
    ]
    existing: dict[str, dict[str, Any]] = {}

    for names in _chunks(alarm_names):
        response = cloudwatch.describe_alarms(AlarmNames=names)
        existing.update(
            {alarm["AlarmName"]: alarm for alarm in response.get("MetricAlarms", [])}
        )

    updated: list[str] = []
    for load_balancer, suffix, target_group in desired:
        name = _alarm_name(
            load_balancer["name"],
            suffix,
            target_group,
            len(load_balancer["target_groups"]),
        )
        if not _is_compliant(
            existing.get(name, {}),
            load_balancer,
            suffix,
            topic_arn,
            target_group,
        ):
            cloudwatch.put_metric_alarm(
                **_alarm_configuration(
                    load_balancer,
                    suffix,
                    topic_arn,
                    target_group,
                )
            )
            updated.append(name)

    deleted = _stale_alarm_names(cloudwatch, set(alarm_names))
    for names in _chunks(deleted):
        cloudwatch.delete_alarms(AlarmNames=names)

    result = {
        "load_balancers": len(load_balancers),
        "covered_alarms": len(desired),
        "updated_alarms": updated,
        "deleted_alarms": deleted,
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
