#!/usr/bin/env python3

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/deploy-preview.yml").read_text()
SCRIPT = (ROOT / "infra/scripts/ecs-preview.sh").read_text()
TERRAFORM = (ROOT / "infra/terraform/environments/preview/main.tf").read_text()


class PreviewRuntimeContract(unittest.TestCase):
    def test_deploy_precedes_vercel_wiring_and_requires_exact_health(self):
        self.assertIn("needs: [build-api, build-gateway]", WORKFLOW)
        self.assertIn("needs: deploy", WORKFLOW)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", WORKFLOW)
        self.assertIn("pull_request_target:", WORKFLOW)
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", WORKFLOW)
        self.assertIn('[ "$environment" = "preview" ]', WORKFLOW)
        self.assertIn('[ "$commit" = "$COMMIT" ]', WORKFLOW)
        self.assertIn("KORTIX_PUBLIC_BACKEND_URL", WORKFLOW)
        self.assertIn("NEXT_PUBLIC_BACKEND_URL", WORKFLOW)
        self.assertNotIn("Argo CD", WORKFLOW)

    def test_close_and_unlabel_run_complete_base_branch_teardown(self):
        self.assertIn("github.event.action == 'closed'", WORKFLOW)
        self.assertIn("github.event.label.name == 'preview'", WORKFLOW)
        self.assertNotIn("bash infra/scripts/ecs-preview.sh", WORKFLOW.split("ref: ${{ github.event.pull_request.head.sha }}")[1].split("deploy:")[0])
        self.assertIn("ecs-preview.sh teardown", WORKFLOW)
        for command in (
            "aws ecs delete-service",
            "aws elbv2 delete-rule",
            "aws elbv2 delete-target-group",
            "aws ecs deregister-task-definition",
        ):
            self.assertIn(command, SCRIPT)

    def test_each_pr_has_isolated_routing_and_preview_secret_delivery(self):
        self.assertIn('SERVICE="kortix-pr-${PR}"', SCRIPT)
        self.assertIn('HOST="pr-${PR}.preview-api.kortix.com"', SCRIPT)
        self.assertIn('SECRET_NAME="kortix-preview-env"', SCRIPT)
        self.assertIn('{"name": "INTERNAL_KORTIX_ENV", "value": "preview"}', SCRIPT)
        self.assertIn('{"name": "KORTIX_WORKERS_ENABLED", "value": "false"}', SCRIPT)
        self.assertIn('{"name": "KORTIX_SKIP_ENSURE_SCHEMA", "value": "1"}', SCRIPT)
        self.assertIn('"LLM_GATEWAY_PROXY_TARGET", "value": "http://127.0.0.1:8090"', SCRIPT)
        self.assertNotIn("kortix-prod-env", SCRIPT)

    def test_shared_edge_has_tls_waf_logs_and_preview_only_oidc_role(self):
        for fragment in (
            'name = "kortix-preview"',
            "certificate_arn   = var.preview_certificate_arn",
            'resource "aws_wafv2_web_acl_association" "preview"',
            "drop_invalid_header_fields = true",
            "enable_deletion_protection = true",
            'name    = "*.preview-api"',
            "proxied = false",
            'name = "kortix-gha-preview-deploy"',
            '"token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:pull_request"',
            '"token.actions.githubusercontent.com:job_workflow_ref" = "kortix-ai/suna/.github/workflows/deploy-preview.yml@refs/heads/*"',
            'description = "DNS over UDP"',
            'resource "aws_iam_role_policy" "execution_logs_kms"',
        ):
            self.assertIn(fragment, TERRAFORM)


if __name__ == "__main__":
    unittest.main()
