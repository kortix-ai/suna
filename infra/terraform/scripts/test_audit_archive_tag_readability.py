#!/usr/bin/env python3
"""Regression test for Drata test 8028 "Resource Tagging" (control DCF-777).

Drata's IaC scanner resolves a resource's `tags` only when the map's keys are
literal: `tags = var.tags`, `tags = merge(var.tags, …)` and maps with
interpolated keys all read as `{}` and fail test 8028, even though Terraform
resolves them at apply time. The repo's convention for module resources (the
ecs-api execution role) is a literal-keyed map with caller context flowing
through `lookup(var.tags, …)` values. KRTX-1649 moved the audit archive onto
that convention; this guard keeps it there.
"""

from pathlib import Path
import re
import sys


MODULE = Path(__file__).parents[1] / "modules" / "audit-archive-bucket" / "main.tf"
SCANNED_RESOURCES = [
    ("aws_s3_bucket", "audit_archive"),
    ("aws_kms_key", "audit_archive"),
]
OPAQUE_TAGS = re.compile(r"tags\s*=\s*(merge\(|var\.tags\b)")


def resource_body(source: str, resource_type: str, name: str) -> str:
    match = re.search(
        rf'resource\s+"{re.escape(resource_type)}"\s+"{re.escape(name)}"\s*{{',
        source,
    )
    assert match, f"missing {resource_type}.{name}"

    depth = 1
    cursor = match.end()
    while cursor < len(source) and depth:
        if source[cursor] == "{":
            depth += 1
        elif source[cursor] == "}":
            depth -= 1
        cursor += 1

    assert depth == 0, f"unterminated {resource_type}.{name}"
    return source[match.end() : cursor - 1]


def assert_tags_are_drata_readable(source: str) -> None:
    for resource_type, name in SCANNED_RESOURCES:
        body = resource_body(source, resource_type, name)
        assert re.search(r"tags\s*=", body), f"{resource_type}.{name} must declare tags (test 8028)"
        assert not OPAQUE_TAGS.search(body), (
            f"{resource_type}.{name} tags must be a literal-keyed map: "
            "merge()/var.tags reads as {} in Drata's IaC scanner (test 8028)"
        )
        assert re.search(r'tags\s*=\s*\{\s*ManagedBy\s*=\s*"terraform"', body), (
            f"{resource_type}.{name} tags must start with a literal "
            'ManagedBy = "terraform" key'
        )


def test_module_tags_are_drata_readable() -> None:
    assert_tags_are_drata_readable(MODULE.read_text())


def test_opaque_tags_are_rejected() -> None:
    source = """
resource "aws_s3_bucket" "audit_archive" {
  bucket = "b"
  tags   = merge(var.tags, { Name = var.name })
}
"""
    try:
        assert_tags_are_drata_readable(source)
    except AssertionError:
        return
    raise AssertionError("merge(var.tags, …) tags passed the test-8028 guard")


def test_missing_tags_are_rejected() -> None:
    source = """
resource "aws_kms_key" "audit_archive" {
  description = "k"
}
"""
    try:
        assert_tags_are_drata_readable(source)
    except AssertionError:
        return
    raise AssertionError("untagged resources passed the test-8028 guard")


if __name__ == "__main__":
    tests = [value for key, value in sorted(globals().items()) if key.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"ok   {test.__name__}")
        except AssertionError as exc:
            print(f"FAIL {test.__name__}: {exc}")
            failed += 1
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
