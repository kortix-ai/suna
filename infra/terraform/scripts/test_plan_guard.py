#!/usr/bin/env python3
"""Tests for plan_guard.py and terraform_roots.py (stdlib unittest, no cloud).

The guard is the last gate before `terraform apply` runs unattended on `main`.
A regression that lets a delete through destroys production resources, so
each rule has a case here: a plain delete blocks, a replace blocks, the ECS
task-definition replacement passes, the reviewed override passes, report-only
never fails, stateful types are named, and email keys never reach the public
summary.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.dont_write_bytecode = True  # keep __pycache__ out of the tree
sys.path.insert(0, str(HERE))

import plan_guard  # noqa: E402
import terraform_roots  # noqa: E402


def change(address, rtype, actions):
    return {"address": address, "type": rtype, "change": {"actions": actions}}


def run_guard(plan, *flags):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "plan.json"
        path.write_text(json.dumps(plan))
        summary = Path(tmp) / "summary.md"
        result = subprocess.run(
            [sys.executable, str(HERE / "plan_guard.py"), str(path), "--root", "infra/terraform/x", "--summary", str(summary), *flags],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.returncode, result.stdout, summary.read_text() if summary.exists() else ""


class PlanGuardTest(unittest.TestCase):
    def test_creates_and_updates_pass(self):
        plan = {"resource_changes": [
            change("aws_cloudwatch_metric_alarm.a", "aws_cloudwatch_metric_alarm", ["create"]),
            change("aws_sns_topic.t", "aws_sns_topic", ["update"]),
            change("data.aws_caller_identity.me", "aws_caller_identity", ["read"]),
            change("aws_s3_bucket.logs", "aws_s3_bucket", ["no-op"]),
        ]}
        code, out, summary = run_guard(plan)
        self.assertEqual(code, 0, out)
        self.assertIn("Plan: 1 create, 1 update.", summary)
        self.assertIn("Guard: **pass**", summary)

    def test_empty_plan_passes(self):
        code, _, summary = run_guard({"resource_changes": []})
        self.assertEqual(code, 0)
        self.assertIn("Plan: no changes.", summary)

    def test_plain_delete_blocks(self):
        plan = {"resource_changes": [change("aws_security_group_rule.x", "aws_security_group_rule", ["delete"])]}
        code, out, summary = run_guard(plan)
        self.assertEqual(code, 1)
        self.assertIn("::error::", out)
        self.assertIn("terraform-destroy-ok", out)
        self.assertIn("Guard: **blocked**", summary)
        self.assertIn("| `aws_security_group_rule.x` | delete | no |", summary)

    def test_replace_blocks_and_names_data_loss(self):
        plan = {"resource_changes": [change("module.api.aws_s3_bucket.alb_logs", "aws_s3_bucket", ["delete", "create"])]}
        code, _, summary = run_guard(plan)
        self.assertEqual(code, 1)
        self.assertIn("| `module.api.aws_s3_bucket.alb_logs` | replace | DATA LOSS |", summary)

    def test_task_definition_replacement_passes(self):
        for actions in (["delete", "create"], ["create", "delete"]):
            plan = {"resource_changes": [change("module.api.aws_ecs_task_definition.api", "aws_ecs_task_definition", actions)]}
            code, out, summary = run_guard(plan)
            self.assertEqual(code, 0, out)
            self.assertIn("Allowed ECS task-definition replacements: 1.", summary)

    def test_task_definition_plain_delete_blocks(self):
        plan = {"resource_changes": [change("aws_ecs_task_definition.old", "aws_ecs_task_definition", ["delete"])]}
        self.assertEqual(run_guard(plan)[0], 1)

    def test_allow_deletes_passes_with_warning(self):
        plan = {"resource_changes": [change("aws_iam_user.old", "aws_iam_user", ["delete"])]}
        code, out, summary = run_guard(plan, "--allow-deletes")
        self.assertEqual(code, 0)
        self.assertIn("::warning::", out)
        self.assertIn("Guard: **allowed**", summary)
        self.assertIn("DATA LOSS", summary)

    def test_report_only_never_fails(self):
        plan = {"resource_changes": [change("aws_kms_key.k", "aws_kms_key", ["delete"])]}
        code, out, _ = run_guard(plan, "--report-only")
        self.assertEqual(code, 0)
        self.assertIn("::warning::", out)

    def test_unreadable_plan_exits_2(self):
        result = subprocess.run(
            [sys.executable, str(HERE / "plan_guard.py"), "/nonexistent/plan.json"],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)

    def test_email_keys_are_redacted(self):
        plan = {"resource_changes": [change('aws_sns_topic_subscription.email["ops@example.test"]', "aws_sns_topic_subscription", ["delete"])]}
        _, out, summary = run_guard(plan)
        self.assertNotIn("ops@example.test", summary)
        self.assertNotIn("ops@example.test", out)
        self.assertIn('aws_sns_topic_subscription.email["<redacted>"]', summary)

    def test_stateful_matching_is_exact_or_prefix(self):
        self.assertTrue(plan_guard.is_stateful("aws_s3_bucket"))
        self.assertFalse(plan_guard.is_stateful("aws_s3_bucket_policy"))
        self.assertTrue(plan_guard.is_stateful("aws_db_instance"))
        self.assertTrue(plan_guard.is_stateful("aws_iam_role"))
        self.assertFalse(plan_guard.is_stateful("aws_iam_role_policy"))


class TerraformRootsTest(unittest.TestCase):
    def affected(self, *changed):
        return terraform_roots.affected_roots(list(changed), REPO)

    def test_root_change_selects_that_root(self):
        self.assertEqual(self.affected("infra/terraform/compliance-monitoring/alarms.tf"), ["infra/terraform/compliance-monitoring"])

    def test_module_change_selects_every_caller(self):
        roots = self.affected("infra/terraform/modules/ecs-api/main.tf")
        self.assertIn("infra/terraform/environments/dev", roots)
        self.assertIn("infra/terraform/environments/prod", roots)
        self.assertNotIn("infra/terraform/security-baseline", roots)

    def test_pipeline_change_selects_every_root(self):
        self.assertEqual(self.affected(".github/workflows/terraform-ci.yml"), list(terraform_roots.PLAN_ROOTS))

    def test_unrelated_change_selects_nothing(self):
        self.assertEqual(self.affected("apps/api/src/index.ts", "infra/terraform/README.md"), [])

    def test_preview_root_is_never_planned(self):
        self.assertEqual(self.affected("infra/terraform/environments/preview/main.tf"), [])

    def test_every_plan_root_exists(self):
        for root in terraform_roots.PLAN_ROOTS:
            self.assertTrue((REPO / root / "backend.tf").is_file(), root)


if __name__ == "__main__":
    unittest.main()
