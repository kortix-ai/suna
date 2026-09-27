#!/usr/bin/env python3
"""Fails when an environment's API region and its DATABASE_URL secret region
disagree.

Both values are read straight out of the Terraform environment files as
committed text — no `terraform plan`, no provider, no AWS credentials. That is
the whole point: this is the enforcer for the class of incident this migration
fixes (an API stack silently drifting away from its database's region), and it
has to work for an operator who cannot get AWS credentials in this account
(see the apply runbook in PR #7844) and for CI, which never
carries them for infra/terraform/scripts/*.py (see terraform-ci.yml).

Region-of-truth per environment:
  - `variable "aws_region" { default = "..." }` — where the API/gateway ECS
    stack in that root actually runs.
  - `variable "database_region" { default = "..." }` — the AWS region of that
    environment's DATABASE_URL Secrets Manager entry (the hosted Supabase
    Postgres instance). This is a NEW variable added by the region-colocation
    change specifically so this fact is declared once, in one place, instead
    of being inferred from a 60+ entry secrets map that may not even exist in
    every root (staging/variables.tf's `api_secrets` default is `{}` — it has
    never committed a literal DATABASE_URL ARN).

`infra/terraform/environments/region-map.json` says which root is CURRENTLY
declared authoritative for each environment. Only those roots are asserted to
pass. A root not listed there (the legacy dev/ and staging/ roots, kept live
and unmigrated until the runbook's decommission step) is intentionally not
gated — its variables.tf says so, in words, right next to its
`database_region` default — but this script still lists what it found for
every root under environments/, so the "before" state (dev, staging failing;
prod passing) stays directly reproducible by running this file at any commit.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENVIRONMENTS_DIR = ROOT / "terraform" / "environments"
REGION_MAP_PATH = ENVIRONMENTS_DIR / "region-map.json"

_VAR_DEFAULT_RE_TEMPLATE = (
    r'variable\s+"{name}"\s*\{{'  # variable "<name>" {
    r'(?:[^{{}}]|\{{[^{{}}]*\}})*?'  # skip nested blocks (e.g. validation {...})
    r'default\s*=\s*"([^"]+)"'  # default = "<value>"
)


def _extract_variable_default(text: str, name: str) -> str | None:
    """Return the literal `default = "..."` value of `variable "<name>"`.

    Handles a variable block that contains a nested `validation { ... }`
    block (as this migration's new database_region variables do) by allowing
    one level of nested braces before the default assignment.
    """
    pattern = _VAR_DEFAULT_RE_TEMPLATE.format(name=re.escape(name))
    match = re.search(pattern, text, re.DOTALL)
    return match.group(1) if match else None


def read_environment_regions(env_dir: pathlib.Path) -> tuple[str | None, str | None]:
    """Return (aws_region, database_region) declared in one environment root.

    Reads every *.tf file in the root (aws_region and database_region are not
    guaranteed to be declared in the same file forever) and returns the first
    match for each variable name.
    """
    aws_region = None
    database_region = None
    for tf_file in sorted(env_dir.glob("*.tf")):
        text = tf_file.read_text()
        if aws_region is None:
            aws_region = _extract_variable_default(text, "aws_region")
        if database_region is None:
            database_region = _extract_variable_default(text, "database_region")
    return aws_region, database_region


def discover_environment_roots() -> list[str]:
    """Every directory directly under environments/ that declares aws_region."""
    roots = []
    for child in sorted(ENVIRONMENTS_DIR.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        aws_region, _ = read_environment_regions(child)
        if aws_region is not None:
            roots.append(child.name)
    return roots


def load_region_map() -> dict[str, str]:
    raw = json.loads(REGION_MAP_PATH.read_text())
    return {k: v for k, v in raw.items() if not k.startswith("$")}


class RegionColocationTests(unittest.TestCase):
    def test_region_map_points_at_real_roots(self):
        region_map = load_region_map()
        self.assertTrue(region_map, "region-map.json must name at least one environment")
        for environment, root in region_map.items():
            with self.subTest(environment=environment):
                self.assertTrue(
                    (ENVIRONMENTS_DIR / root).is_dir(),
                    f"region-map.json points {environment!r} at "
                    f"environments/{root}, which does not exist",
                )

    def test_every_authoritative_root_declares_both_regions(self):
        region_map = load_region_map()
        for environment, root in region_map.items():
            with self.subTest(environment=environment, root=root):
                aws_region, database_region = read_environment_regions(
                    ENVIRONMENTS_DIR / root
                )
                self.assertIsNotNone(
                    aws_region,
                    f"{root}/*.tf declares no `variable \"aws_region\"` default",
                )
                self.assertIsNotNone(
                    database_region,
                    f"{root}/*.tf declares no `variable \"database_region\"` "
                    "default — every root the enforcer checks must state its "
                    "database's region explicitly, not leave it to be assumed",
                )

    def test_api_region_matches_database_region(self):
        """The enforcer. Prod must pass today; dev/staging pass only through
        their -us-east-2 / -eu-west-2 successor roots (region-map.json)."""
        region_map = load_region_map()
        failures = []
        for environment, root in region_map.items():
            aws_region, database_region = read_environment_regions(
                ENVIRONMENTS_DIR / root
            )
            if aws_region != database_region:
                failures.append(
                    f"  {environment} (environments/{root}): "
                    f"aws_region={aws_region!r} != database_region={database_region!r}"
                )
        self.assertFalse(
            failures,
            "API region and database region disagree for:\n" + "\n".join(failures),
        )


def _print_survey():
    """Non-assertion helper: print every discovered root's regions and
    verdict. Run this file directly (not via unittest) to reproduce the
    before/after table from the command line."""
    region_map = load_region_map()
    authoritative = {root for root in region_map.values()}
    print(f"{'root':<24}{'aws_region':<14}{'database_region':<18}{'colocated?':<12}{'authoritative?'}")
    for root in discover_environment_roots():
        aws_region, database_region = read_environment_regions(ENVIRONMENTS_DIR / root)
        colocated = "yes" if aws_region == database_region else "NO"
        auth = "yes" if root in authoritative else "no (legacy/unmigrated)"
        print(f"{root:<24}{str(aws_region):<14}{str(database_region):<18}{colocated:<12}{auth}")


if __name__ == "__main__":
    if "--survey" in sys.argv:
        _print_survey()
    else:
        unittest.main()
