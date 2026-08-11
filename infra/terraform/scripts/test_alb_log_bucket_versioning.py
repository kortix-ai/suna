#!/usr/bin/env python3
"""Regression test for DCF-78 ALB log bucket versioning."""

from pathlib import Path
import re


MODULE = Path(__file__).parents[1] / "modules" / "ecs-api" / "main.tf"


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


def assert_alb_logs_versioning_enabled(source: str) -> None:
    body = resource_body(source, "aws_s3_bucket_versioning", "alb_logs")
    assert re.search(r"bucket\s*=\s*aws_s3_bucket\.alb_logs\.id", body), (
        "alb_logs versioning must target aws_s3_bucket.alb_logs"
    )
    assert re.search(r'versioning_configuration\s*{[^}]*status\s*=\s*"Enabled"', body), (
        "alb_logs versioning status must be Enabled"
    )


def test_module_enables_alb_log_bucket_versioning() -> None:
    assert_alb_logs_versioning_enabled(MODULE.read_text())


def test_missing_versioning_is_rejected() -> None:
    source = 'resource "aws_s3_bucket" "alb_logs" { bucket = "logs" }'
    try:
        assert_alb_logs_versioning_enabled(source)
    except AssertionError:
        return
    raise AssertionError("a bucket without versioning passed the DCF-78 guard")


def test_suspended_versioning_is_rejected() -> None:
    source = """
resource "aws_s3_bucket_versioning" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  versioning_configuration {
    status = "Suspended"
  }
}
"""
    try:
        assert_alb_logs_versioning_enabled(source)
    except AssertionError:
        return
    raise AssertionError("suspended versioning passed the DCF-78 guard")


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
    raise SystemExit(1 if failed else 0)
