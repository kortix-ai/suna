#!/usr/bin/env python3
"""Regression tests for audit-nacl-admin-ports.

Dependency-free on purpose: `python3 test_audit_nacl_admin_ports.py`.

The case that matters most is `test_udp_hole_is_caught`. The ACL that failed
the Drata control had SSH and RDP correctly carved out of its TCP rules but
left UDP wide open, so a TCP-only reading of the ruleset called it compliant.

The mixed-family cases guard the per-family walk: AWS applies a packet only
to rules whose CIDR matches the packet's address family, so an IPv6-wide
deny must never decide an IPv4 verdict, and vice versa.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "audit", Path(__file__).with_name("audit-nacl-admin-ports.py")
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def acl(entries: list[dict], acl_id: str = "acl-test") -> dict:
    return {
        "NetworkAclId": acl_id,
        "VpcId": "vpc-test",
        "IsDefault": False,
        "Entries": entries,
        "Associations": [{"SubnetId": "subnet-test"}],
    }


def allow(rule_no, protocol, from_port=None, to_port=None, cidr="0.0.0.0/0"):
    entry = {
        "RuleNumber": rule_no,
        "Protocol": protocol,
        "RuleAction": "allow",
        "Egress": False,
        # An entry carries exactly one CIDR; the family follows the address.
        ("Ipv6CidrBlock" if ":" in cidr else "CidrBlock"): cidr,
    }
    if from_port is not None:
        entry["PortRange"] = {"From": from_port, "To": to_port}
    return entry


def deny(rule_no, protocol, from_port=None, to_port=None, cidr="0.0.0.0/0"):
    entry = allow(rule_no, protocol, from_port, to_port, cidr)
    entry["RuleAction"] = "deny"
    return entry


DENY_ALL = deny(32767, "-1")


def ports(findings) -> set:
    return {(f["protocol"], f["port"]) for f in findings}


def test_udp_hole_is_caught():
    """The exact pre-fix us-east-2 ruleset: TCP carved, UDP wide open."""
    entries = [
        allow(50, "-1", cidr="10.40.0.0/16"),
        allow(100, "6", 0, 21),
        allow(110, "6", 23, 3388),
        allow(120, "6", 3390, 65535),
        allow(130, "17", 0, 65535),  # the hole
        DENY_ALL,
    ]
    found = ports(audit.audit_acl(acl(entries), "us-east-2"))
    assert found == {("udp", 22), ("udp", 3389)}, found


def test_fixed_ruleset_is_clean():
    """The same ACL after splitting the UDP range."""
    entries = [
        allow(50, "-1", cidr="10.40.0.0/16"),
        allow(100, "6", 0, 21),
        allow(110, "6", 23, 3388),
        allow(120, "6", 3390, 65535),
        allow(130, "17", 0, 21),
        allow(140, "17", 23, 3388),
        allow(150, "17", 3390, 65535),
        DENY_ALL,
    ]
    assert audit.audit_acl(acl(entries), "us-east-2") == []


def test_module_baseline_is_clean():
    """The baseline modules/network writes: ephemeral ranges split around RDP."""
    entries = [
        allow(1, "-1", cidr="10.20.0.0/16"),
        allow(110, "6", 80, 80),
        allow(120, "6", 443, 443),
        allow(130, "6", 1024, 3388),
        allow(140, "6", 3390, 65535),
        allow(150, "17", 1024, 3388),
        allow(160, "17", 3390, 65535),
        allow(170, "1"),
        DENY_ALL,
    ]
    assert audit.audit_acl(acl(entries), "eu-west-2") == []


def test_default_vpc_acl_is_caught():
    """An untouched AWS default NACL allows everything from anywhere."""
    found = ports(audit.audit_acl(acl([allow(100, "-1"), DENY_ALL]), "us-west-1"))
    assert found == {("tcp", 22), ("udp", 22), ("tcp", 3389), ("udp", 3389)}, found


def test_deny_before_allow_wins():
    """Explicit denies ahead of a broad allow are compliant: first match wins."""
    entries = [
        deny(90, "6", 22, 22),
        deny(91, "6", 3389, 3389),
        deny(92, "17", 22, 22),
        deny(93, "17", 3389, 3389),
        allow(100, "-1"),
        DENY_ALL,
    ]
    assert audit.audit_acl(acl(entries), "us-west-2") == []


def test_allow_before_deny_still_fails():
    """Ordering is real: a deny placed after the allow never applies."""
    entries = [allow(100, "-1"), deny(200, "6", 22, 22), DENY_ALL]
    assert ("tcp", 22) in ports(audit.audit_acl(acl(entries), "us-west-2"))


def test_narrow_source_is_not_a_finding():
    """SSH from the corporate range is not internet exposure."""
    entries = [allow(100, "6", 22, 22, cidr="10.0.0.0/8"), DENY_ALL]
    assert audit.audit_acl(acl(entries), "us-west-2") == []


def test_egress_is_ignored():
    entries = [dict(allow(100, "-1"), Egress=True), DENY_ALL]
    assert audit.audit_acl(acl(entries), "us-west-2") == []


def test_ipv6_open_source_is_caught():
    entries = [allow(100, "6", 22, 22, cidr="::/0"), DENY_ALL]
    assert ("tcp", 22) in ports(audit.audit_acl(acl(entries), "us-west-2"))


def test_ipv6_deny_does_not_hide_ipv4_allow():
    """A v6-wide deny applies only to v6 packets: the v4-wide allow behind it decides."""
    entries = [
        deny(90, "6", 22, 22, cidr="::/0"),
        allow(100, "6", 22, 22),
    ]
    found = ports(audit.audit_acl(acl(entries), "us-west-2"))
    assert found == {("tcp", 22)}, found


def test_ipv4_deny_does_not_hide_ipv6_allow():
    """Mirror case: a v4-wide deny leaves the v6-wide allow behind it decisive."""
    entries = [
        deny(90, "6", 22, 22),
        allow(100, "6", 22, 22, cidr="::/0"),
    ]
    found = ports(audit.audit_acl(acl(entries), "us-west-2"))
    assert found == {("tcp", 22)}, found


def test_first_wide_rule_of_each_family_decides():
    """Each family walks the rules on its own: its own deny still wins over a later allow."""
    entries = [
        deny(90, "6", 22, 22, cidr="::/0"),
        deny(95, "6", 22, 22),
        allow(100, "6", 22, 22),
        allow(105, "6", 22, 22, cidr="::/0"),
    ]
    assert audit.audit_acl(acl(entries), "us-west-2") == []


def test_narrow_and_other_family_rules_never_decide():
    """Narrow sources never match internet packets, and only the family's own rules apply."""
    entries = [
        deny(80, "6", 22, 22, cidr="10.0.0.0/8"),
        deny(90, "6", 22, 22, cidr="::/0"),
        allow(100, "6", 22, 22),
    ]
    found = ports(audit.audit_acl(acl(entries), "us-west-2"))
    assert found == {("tcp", 22)}, found


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
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
