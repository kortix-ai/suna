#!/usr/bin/env python3

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/deploy-preview.yml").read_text()
SCRIPT = (ROOT / "infra/scripts/ecs-preview.sh").read_text()
TERRAFORM = (ROOT / "infra/terraform/environments/preview/main.tf").read_text()
VARIABLES = (ROOT / "infra/terraform/environments/preview/variables.tf").read_text()
README = (ROOT / "infra/terraform/environments/preview/README.md").read_text()


class PreviewRuntimeContract(unittest.TestCase):
    def test_deploy_requires_exact_api_and_frontend_health(self):
        self.assertIn("needs: [authorize, build-api, build-gateway, build-web]", WORKFLOW)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", WORKFLOW)
        self.assertIn("pull_request_target:", WORKFLOW)
        self.assertIn("branches: [main]", WORKFLOW)
        self.assertIn("ref: ${{ github.event.repository.default_branch }}", WORKFLOW)
        self.assertIn('[ "$api_environment" = "preview" ]', WORKFLOW)
        self.assertIn('[ "$api_commit" = "$COMMIT" ]', WORKFLOW)
        self.assertIn('[ "$web_commit" = "$COMMIT" ]', WORKFLOW)
        self.assertIn("kortix/kortix-frontend:pr-${{ github.event.pull_request.head.sha }}", WORKFLOW)
        self.assertIn('web_host="pr-${NUM}.preview.kortix.com"', WORKFLOW)
        self.assertIn("WEB_PROTECTION_PASSWORD", WORKFLOW)
        self.assertIn("cookie_only", WORKFLOW)
        self.assertNotIn("Vercel", WORKFLOW)
        self.assertNotIn("VERCEL_", WORKFLOW)
        self.assertNotIn("Argo CD", WORKFLOW)
        self.assertNotIn("submodule update --init --recursive --remote", WORKFLOW)

    def test_pr_code_builds_without_credentials_and_publish_never_runs_it(self):
        self.assertEqual(WORKFLOW.count("persist-credentials: false"), 3)
        self.assertEqual(WORKFLOW.count("push: false"), 3)
        self.assertEqual(WORKFLOW.count("type=docker,dest=/tmp/preview-"), 3)
        self.assertEqual(WORKFLOW.count("actions/upload-artifact@v7"), 3)
        self.assertEqual(WORKFLOW.count("actions/download-artifact@v8"), 3)
        for build, next_job in (
            ("build-api:", "build-gateway:"),
            ("build-gateway:", "build-web:"),
            ("build-web:", "deploy:"),
        ):
            section = WORKFLOW.split(f"  {build}", 1)[1].split(f"\n  {next_job}", 1)[0]
            self.assertIn("permissions:\n      contents: read", section)
            self.assertNotIn("DOCKERHUB_", section)
            self.assertNotIn("docker/login-action", section)
            self.assertNotIn("push: true", section)
        deploy = WORKFLOW.split("  deploy:", 1)[1].split("\n  teardown:", 1)[0]
        self.assertIn("docker/login-action@v3", deploy)
        self.assertIn("docker load --input", deploy)
        self.assertIn("docker push", deploy)
        self.assertNotIn("docker run", deploy)

    def test_preview_label_approves_one_exact_sha(self):
        self.assertIn("github.event.action == 'labeled'", WORKFLOW)
        self.assertIn("github.event.label.name == 'preview'", WORKFLOW)
        self.assertIn('case "$permission" in', WORKFLOW)
        self.assertIn("admin|write)", WORKFLOW)
        self.assertNotIn("['labeled','opened','synchronize','reopened']", WORKFLOW)
        self.assertIn("github.event.action == 'synchronize'", WORKFLOW)
        self.assertIn("gh api -X DELETE", WORKFLOW)
        self.assertIn("labels/preview", WORKFLOW)
        self.assertNotIn("KORTIX_PREVIEW_APPROVED_SHA", WORKFLOW)

    def test_close_and_unlabel_run_complete_base_branch_teardown(self):
        self.assertIn("github.event.action == 'closed'", WORKFLOW)
        self.assertIn("github.event.label.name == 'preview'", WORKFLOW)
        privileged = WORKFLOW.split("deploy:", 1)[1]
        for section in privileged.split("- uses: aws-actions/configure-aws-credentials")[1:]:
            before_script = section.split("ecs-preview.sh", 1)[0]
            self.assertNotIn("github.event.pull_request.head.sha", before_script)
        self.assertIn("ecs-preview.sh teardown", WORKFLOW)
        self.assertNotIn("branch-scoped Vercel", WORKFLOW)
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
        self.assertIn('WEB_HOST="pr-${PR}.preview.kortix.com"', SCRIPT)
        self.assertIn('SECRET_NAME="kortix-preview-env"', SCRIPT)
        self.assertIn('WEB_SECRET_NAME="kortix-preview-web-env"', SCRIPT)
        self.assertIn('{"name": "INTERNAL_KORTIX_ENV", "value": "preview"}', SCRIPT)
        self.assertIn('{"name": "KORTIX_WORKERS_ENABLED", "value": "false"}', SCRIPT)
        self.assertIn('{"name": "KORTIX_SKIP_ENSURE_SCHEMA", "value": "1"}', SCRIPT)
        self.assertIn('"LLM_GATEWAY_PROXY_TARGET", "value": "http://127.0.0.1:8090"', SCRIPT)
        self.assertIn('"name": "web"', SCRIPT)
        self.assertIn('"containerPort": 3000', SCRIPT)
        self.assertIn('"name": "NEXT_PUBLIC_APP_URL", "value": web_url', SCRIPT)
        self.assertIn('"name": "NEXT_PUBLIC_BACKEND_URL", "value": backend_url', SCRIPT)
        self.assertIn('"name": "KORTIX_PUBLIC_VERSION"', SCRIPT)
        self.assertIn("f\"pr-{family.removeprefix('kortix-pr-')}\"", SCRIPT)
        self.assertNotIn("kortix-prod-env", SCRIPT)
        self.assertIn("rollback_deploy", SCRIPT)
        self.assertIn("PREVIOUS_TASK_DEFINITION", SCRIPT)
        self.assertIn('MAX_ACTIVE_PREVIEWS="${MAX_ACTIVE_PREVIEWS:-20}"', SCRIPT)
        self.assertIn('PREVIEW_MAX_AGE_HOURS:-72', SCRIPT)
        self.assertIn("ecs-preview.sh reconcile 0", WORKFLOW)
        self.assertIn("preserving its preview", SCRIPT)
        self.assertNotIn("|| printf closed", SCRIPT)

    def test_shared_edge_has_tls_waf_logs_and_preview_only_oidc_role(self):
        for fragment in (
            'name = "kortix-preview"',
            "certificate_arn   = var.preview_certificate_arn",
            'resource "aws_wafv2_web_acl_association" "preview"',
            "drop_invalid_header_fields = true",
            "enable_deletion_protection = true",
            'name    = "*.preview-api"',
            'name    = "*.preview"',
            'domain_name = "*.preview.kortix.com"',
            'resource "aws_lb_listener_certificate" "frontend"',
            'data "aws_secretsmanager_secret" "web"',
            'name = "kortix-preview-web-env"',
            "proxied = false",
            'name = "kortix-gha-preview-deploy"',
            '"repo:kortix-ai/suna:pull_request"',
            '"repo:kortix-ai/suna:ref:refs/heads/main"',
            '"token.actions.githubusercontent.com:job_workflow_ref" = "kortix-ai/suna/.github/workflows/deploy-preview.yml@refs/heads/main"',
            'description = "DNS over UDP"',
            'resource "aws_iam_role_policy" "execution_logs_kms"',
            'resource "aws_wafv2_web_acl" "preview"',
            'name        = "AWSManagedRulesKnownBadInputsRuleSet"',
            'resource "aws_wafv2_web_acl_logging_configuration" "preview"',
        ):
            self.assertIn(fragment, TERRAFORM)

    def test_database_egress_and_bootstrap_are_bounded(self):
        self.assertIn('cidr_blocks = var.postgres_egress_cidrs', TERRAFORM)
        self.assertIn('!contains(var.postgres_egress_cidrs, "0.0.0.0/0")', VARIABLES)
        for heading in ("## Existing-resource import", "## Cutover", "## Reconciliation and rollback"):
            self.assertIn(heading, README)


if __name__ == "__main__":
    unittest.main()
