#!/usr/bin/env python3
"""Destructive-change guard for a saved Terraform plan.

Reads `terraform show -json <plan>` output and blocks every planned delete,
including the delete half of a replace. One exception: an immutable
`aws_ecs_task_definition` replacement, which Terraform always renders as a
delete+create pair and which removes nothing that serves traffic.

`--allow-deletes` turns a block into a warning. Callers set it only for a
reviewed cleanup: a `workflow_dispatch` with `allow_deletes`, or a push whose
merged pull request carries the `terraform-destroy-ok` label.

A delete of a stateful type (data, keys, identities, audit trail) is named
`DATA LOSS` in the output, so a reviewer sees it before adding the label.

Usage:
  plan_guard.py PLAN_JSON [--allow-deletes] [--report-only] [--root NAME]
                [--summary FILE]

Exit 0 when the plan passes, is allowed, or `--report-only` is set.
Exit 1 when a blocked delete remains. Exit 2 on unreadable input.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter

# Resource types whose delete loses data or identity that a re-create cannot
# restore. An entry that ends with `_` matches every type that starts with it;
# any other entry matches that exact type only (aws_s3_bucket, not
# aws_s3_bucket_policy).
STATEFUL_TYPES = (
    "aws_s3_bucket",
    "aws_db_",
    "aws_rds_",
    "aws_dynamodb_table",
    "aws_kms_key",
    "aws_kms_alias",
    "aws_efs_",
    "aws_elasticache_",
    "aws_secretsmanager_secret",
    "aws_ssm_parameter",
    "aws_iam_user",
    "aws_iam_role",
    "aws_iam_openid_connect_provider",
    "aws_cloudtrail",
    "aws_cloudwatch_log_group",
    "aws_ebs_volume",
    "aws_ecr_repository",
    "aws_backup_vault",
    "aws_guardduty_detector",
    "aws_route53_zone",
    "cloudflare_zone",
)

TASK_DEFINITION_REPLACEMENTS = (["delete", "create"], ["create", "delete"])

# A for_each key can hold an email address (an SNS subscription keyed by its
# endpoint). The summary is posted on a public pull request, so such keys are
# redacted.
_EMAIL_KEY = re.compile(r'\["[^"]*@[^"]*"\]')


def redact(address: str) -> str:
    return _EMAIL_KEY.sub('["<redacted>"]', address)


def is_stateful(resource_type: str) -> bool:
    return any(
        resource_type.startswith(entry) if entry.endswith("_") else resource_type == entry
        for entry in STATEFUL_TYPES
    )


def label(actions: list[str]) -> str:
    if "delete" in actions and "create" in actions:
        return "replace"
    return ",".join(actions)


def evaluate(plan: dict) -> dict:
    """Classify every resource change of a plan."""
    counts: Counter[str] = Counter()
    blocked: list[dict] = []
    replacements = 0
    for change in plan.get("resource_changes") or []:
        actions = list((change.get("change") or {}).get("actions") or [])
        if actions in (["no-op"], ["read"], []):
            continue
        counts[label(actions)] += 1
        if "delete" not in actions:
            continue
        rtype = change.get("type", "")
        if rtype == "aws_ecs_task_definition" and actions in TASK_DEFINITION_REPLACEMENTS:
            replacements += 1
            continue
        blocked.append(
            {
                "address": redact(change.get("address", "?")),
                "type": rtype,
                "actions": label(actions),
                "stateful": is_stateful(rtype),
            }
        )
    return {"counts": dict(counts), "blocked": blocked, "task_definition_replacements": replacements}


def summary(result: dict, root: str, allow_deletes: bool) -> str:
    counts = result["counts"]
    blocked = result["blocked"]
    parts = [f"{counts[k]} {k}" for k in sorted(counts)] or ["no changes"]
    lines = [f"#### `{root}`", "", f"Plan: {', '.join(parts)}."]
    if result["task_definition_replacements"]:
        lines.append(f"Allowed ECS task-definition replacements: {result['task_definition_replacements']}.")
    if blocked:
        lines.append("")
        lines.append("| Address | Action | Data loss |")
        lines.append("| --- | --- | --- |")
        for item in blocked:
            lines.append(f"| `{item['address']}` | {item['actions']} | {'DATA LOSS' if item['stateful'] else 'no'} |")
        lines.append("")
        if allow_deletes:
            lines.append(f"Guard: **allowed** — {len(blocked)} delete(s) permitted by a reviewed override.")
        else:
            lines.append(
                f"Guard: **blocked** — {len(blocked)} delete(s). The apply on `main` stops here unless the "
                "pull request carries the `terraform-destroy-ok` label."
            )
    else:
        lines.append("Guard: **pass** — no delete.")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("plan_json")
    parser.add_argument("--allow-deletes", action="store_true")
    parser.add_argument("--report-only", action="store_true", help="Never exit 1; for pull request plans.")
    parser.add_argument("--root", default="terraform root")
    parser.add_argument("--summary", help="Append the Markdown summary to this file.")
    args = parser.parse_args(argv)

    try:
        with open(args.plan_json, encoding="utf-8") as handle:
            plan = json.load(handle)
    except (OSError, ValueError) as error:
        print(f"::error::cannot read plan JSON {args.plan_json}: {error}")
        return 2

    result = evaluate(plan)
    text = summary(result, args.root, args.allow_deletes)
    print(text)
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")

    blocked = result["blocked"]
    if not blocked:
        return 0
    stateful = sum(1 for item in blocked if item["stateful"])
    if args.allow_deletes:
        print(f"::warning::{args.root} deletes {len(blocked)} resource(s) ({stateful} stateful) under a reviewed override.")
        return 0
    if args.report_only:
        print(f"::warning::{args.root} plans {len(blocked)} delete(s) ({stateful} stateful). The apply blocks them without the terraform-destroy-ok label.")
        return 0
    print(f"::error::{args.root} plans {len(blocked)} blocked delete(s) ({stateful} stateful). Add the terraform-destroy-ok label to the pull request, or apply by hand after review.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
