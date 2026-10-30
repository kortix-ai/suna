#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["python-hcl2==7.3.1"]
# ///
"""Exercise the literal-map boundary of Drata 8028 with parsed HCL.

This is a conservative parser-boundary contract, not Drata's proprietary
scanner. Evaluated AWS tags are independently covered by internal_tags.tftest.hcl.
Run: uv run --script infra/terraform/scripts/test_internal_tag_boundary.py
"""
from pathlib import Path
import unittest

import hcl2


ROOT = Path(__file__).parents[1]
NAMES = {"api_internal", "gateway_internal"}
KEYS = {"ManagedBy", "Environment", "Region", "Service", "Name"}


def inventory_maps(document):
    return {
        name: attributes.get("tags")
        for resource in document.get("resource", [])
        for name, attributes in resource.get("aws_security_group", {}).items()
        if name in NAMES
    }


def readable(tags):
    # HCL expressions decode to expression strings, not literal object maps.
    return isinstance(tags, dict) and KEYS <= tags.keys()


class InternalTagBoundary(unittest.TestCase):
    def test_environment_inventory_maps(self):
        with (ROOT / "environments/dev-us-east-2/main.tf").open() as source:
            groups = inventory_maps(hcl2.load(source))
        self.assertEqual(set(groups), NAMES)
        for name, tags in groups.items():
            with self.subTest(resource=name):
                self.assertTrue(readable(tags), f"{name}: Drata requires literal inventory keys")

    def test_opaque_expressions_are_not_literal_maps(self):
        for expression in ('local.tags', 'merge(local.tags, {Name = "synthetic"})'):
            with self.subTest(expression=expression):
                parsed = hcl2.loads('resource "aws_security_group" "api_internal" { tags = ' + expression + ' }')
                self.assertFalse(readable(inventory_maps(parsed)["api_internal"]))

    def test_literal_map_and_missing_keys(self):
        parsed = hcl2.loads('''resource "aws_security_group" "api_internal" {
          tags = { ManagedBy = "terraform", Environment = "dev", Region = "us-east-2", Service = "kortix-api", Name = "${local.name}-api-internal" }
        }''')
        tags = inventory_maps(parsed)["api_internal"]
        self.assertTrue(readable(tags))
        for key in KEYS:
            with self.subTest(missing=key):
                self.assertFalse(readable({name: value for name, value in tags.items() if name != key}))


if __name__ == "__main__":
    unittest.main()
