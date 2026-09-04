#!/usr/bin/env python3

import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
WEB_ENVIRONMENTS = ("dev-web", "staging-web", "prod-web")


class WebWafAssociationTests(unittest.TestCase):
    def test_ecs_module_exposes_alb_arn(self):
        outputs = (ROOT / "terraform/modules/ecs-api/outputs.tf").read_text()
        self.assertIn('output "alb_arn"', outputs)
        self.assertIn("value       = aws_lb.this.arn", outputs)

    def test_each_web_environment_owns_a_regional_waf_association(self):
        for environment in WEB_ENVIRONMENTS:
            with self.subTest(environment=environment):
                config = (
                    ROOT / f"terraform/environments/{environment}/main.tf"
                ).read_text()
                self.assertIn('data "aws_wafv2_web_acl" "regional"', config)
                self.assertIn('name  = "kortix-alb-waf"', config)
                self.assertIn('scope = "REGIONAL"', config)
                self.assertIn(
                    'resource "aws_wafv2_web_acl_association" "web"', config
                )
                self.assertIn("resource_arn = module.web.alb_arn", config)
                self.assertIn(
                    "web_acl_arn  = data.aws_wafv2_web_acl.regional.arn", config
                )

    def test_compliance_stack_does_not_compete_for_web_albs(self):
        config = (ROOT / "terraform/compliance-monitoring/monitoring.tf").read_text()
        self.assertIn("for_each     = local.usw2_compliance_waf_albs", config)
        self.assertIn("for_each     = local.euw2_compliance_waf_albs", config)
        self.assertIn(
            '["kortix-dev-web-alb", "kortix-staging-web-alb"]', config
        )
        self.assertIn('alb.name != "kortix-prod-web-alb"', config)

    def test_common_rules_exclude_only_registered_oauth_loopback_authorize_requests(self):
        config = (
            ROOT / "terraform/compliance-monitoring/use2-security.tf"
        ).read_text()
        self.assertIn("scope_down_statement", config)
        self.assertIn('search_string         = "/v1/oauth/authorize"', config)
        self.assertIn('single_query_argument {', config)
        self.assertIn('name = "redirect_uri"', config)
        self.assertIn('regex_match_statement {', config)
        self.assertIn(
            'regex_string = "^http://(localhost|127\\\\.0\\\\.0\\\\.1)"', config
        )
        self.assertIn('search_string         = "GET"', config)


if __name__ == "__main__":
    unittest.main()
