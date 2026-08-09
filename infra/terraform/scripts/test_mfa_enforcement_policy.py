#!/usr/bin/env python3
"""Regression checks for the DCF-67 IAM MFA enforcement policy."""

from pathlib import Path
import re
import sys


POLICY_FILE = Path(__file__).parents[1] / "security-baseline" / "iam-groups.tf"
SOURCE = POLICY_FILE.read_text()


def resource_body(resource_name: str) -> str:
    marker = f'resource "aws_iam_policy" "{resource_name}"'
    start = SOURCE.index(marker)
    depth = 0
    opened = False
    for index in range(start, len(SOURCE)):
        if SOURCE[index] == "{":
            depth += 1
            opened = True
        elif SOURCE[index] == "}":
            depth -= 1
            if opened and depth == 0:
                return SOURCE[start : index + 1]
    raise AssertionError(f"unterminated resource: {resource_name}")


def not_actions(body: str) -> set[str]:
    match = re.search(r"NotAction\s*=\s*\[(.*?)\]", body, re.DOTALL)
    assert match, "mfa_required must define NotAction"
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def test_password_only_sessions_cannot_remove_mfa():
    actions = not_actions(resource_body("mfa_required"))
    unsafe = {"iam:DeactivateMFADevice", "iam:DeleteVirtualMFADevice"}
    assert actions.isdisjoint(unsafe), f"non-MFA exemptions permit factor removal: {actions & unsafe}"


def test_first_enrollment_remains_available():
    actions = not_actions(resource_body("mfa_required"))
    required = {
        "iam:CreateVirtualMFADevice",
        "iam:EnableMFADevice",
        "iam:ListMFADevices",
        "iam:ListVirtualMFADevices",
        "sts:GetSessionToken",
    }
    assert required <= actions, f"missing first-enrollment exemptions: {required - actions}"


def test_deny_covers_absent_and_false_mfa_context():
    body = resource_body("mfa_required")
    assert 'Effect = "Deny"' in body
    assert "BoolIfExists" in body
    assert '"aws:MultiFactorAuthPresent" = false' in body
    assert 'Resource = "*"' in body


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"ok   {test.__name__}")
        except (AssertionError, ValueError) as exc:
            print(f"FAIL {test.__name__}: {exc}")
            failed += 1
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
