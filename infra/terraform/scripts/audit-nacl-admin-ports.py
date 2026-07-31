#!/usr/bin/env python3
"""Fail if any network ACL exposes SSH (22) or RDP (3389) to the internet.

Terraform only governs the VPCs it creates. This audits what is actually
deployed, so a hand-edited ACL, an imported VPC, or a brand-new region cannot
drift past the control unnoticed.

Rules are evaluated the way AWS evaluates them: ascending rule number, first
match wins. A permissive rule that sits behind an explicit deny is therefore
not a finding, and a rule is only checked against the protocol it applies to
("all protocols" applies to both TCP and UDP).

  ./audit-nacl-admin-ports.py                       # current credentials
  ./audit-nacl-admin-ports.py --profile essentia    # a specific account
  ./audit-nacl-admin-ports.py --region us-east-2    # one region
  ./audit-nacl-admin-ports.py --json                # machine-readable

Exit codes: 0 clean, 1 findings, 2 the scan itself failed.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

ADMIN_PORTS = {22: "SSH", 3389: "RDP"}
# NACL protocol numbers. "-1" means every protocol.
PROTOCOLS = {"6": "tcp", "17": "udp"}
OPEN_CIDRS = {"0.0.0.0/0", "::/0"}


def aws(args: list[str], profile: str | None) -> dict:
    cmd = ["aws", *args, "--output", "json"]
    if profile:
        cmd += ["--profile", profile]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"{' '.join(cmd)} failed")
    return json.loads(proc.stdout)


def regions(profile: str | None) -> list[str]:
    data = aws(["ec2", "describe-regions"], profile)
    return sorted(r["RegionName"] for r in data["Regions"])


def rule_matches(entry: dict, port: int, protocol: str) -> bool:
    """True if this entry is the one AWS applies to (port, protocol)."""
    entry_protocol = entry["Protocol"]
    if entry_protocol not in ("-1", protocol):
        return False
    # "All protocols" entries carry no port range and cover every port.
    port_range = entry.get("PortRange")
    if entry_protocol != "-1" and port_range:
        if not port_range["From"] <= port <= port_range["To"]:
            return False
    return True


def audit_acl(acl: dict, region: str) -> list[dict]:
    inbound = sorted(
        (e for e in acl["Entries"] if not e["Egress"]),
        key=lambda e: e["RuleNumber"],
    )
    findings = []
    for port, service in ADMIN_PORTS.items():
        for protocol, protocol_name in PROTOCOLS.items():
            for entry in inbound:
                if not rule_matches(entry, port, protocol):
                    continue
                cidr = entry.get("CidrBlock") or entry.get("Ipv6CidrBlock")
                # Narrower sources are fine; only an internet-wide rule decides
                # the outcome, and only the first matching one applies.
                if cidr not in OPEN_CIDRS:
                    continue
                if entry["RuleAction"] == "allow":
                    findings.append(
                        {
                            "region": region,
                            "network_acl_id": acl["NetworkAclId"],
                            "vpc_id": acl["VpcId"],
                            "is_default": acl["IsDefault"],
                            "port": port,
                            "service": service,
                            "protocol": protocol_name,
                            "rule_number": entry["RuleNumber"],
                            "cidr": cidr,
                            "subnets": [a["SubnetId"] for a in acl.get("Associations", [])],
                        }
                    )
                break  # first match wins, allow or deny
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", help="AWS profile (default: ambient credentials)")
    parser.add_argument("--region", action="append", help="Region to scan; repeatable")
    parser.add_argument("--json", action="store_true", help="Emit findings as JSON")
    args = parser.parse_args()

    try:
        targets = args.region or regions(args.profile)
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the operator
        print(f"error: could not list regions: {exc}", file=sys.stderr)
        return 2

    findings: list[dict] = []
    scanned = 0
    for region in targets:
        try:
            data = aws(["ec2", "describe-network-acls", "--region", region], args.profile)
        except Exception as exc:  # noqa: BLE001
            print(f"error: {region}: {exc}", file=sys.stderr)
            return 2
        scanned += 1
        for acl in data["NetworkAcls"]:
            findings.extend(audit_acl(acl, region))

    if args.json:
        print(json.dumps(findings, indent=2))
    else:
        account = args.profile or "default credentials"
        for f in findings:
            scope = "default VPC ACL" if f["is_default"] else "custom ACL"
            print(
                f"FAIL {f['region']} {f['network_acl_id']} ({scope}, {f['vpc_id']}): "
                f"rule {f['rule_number']} allows {f['service']} "
                f"({f['protocol']}/{f['port']}) from {f['cidr']} "
                f"-> {len(f['subnets'])} subnet(s)"
            )
        if findings:
            print(f"\n{len(findings)} finding(s) across {scanned} region(s) [{account}]")
        else:
            print(f"clean: no ACL exposes SSH or RDP across {scanned} region(s) [{account}]")

    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
