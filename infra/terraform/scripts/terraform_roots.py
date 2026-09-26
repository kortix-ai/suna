#!/usr/bin/env python3
"""Pick the Terraform roots that a pull request plan must cover.

A root is affected when a changed file is inside the root, or inside a local
module that the root calls directly or through another local module. A change
to the plan workflow or to the plan scripts affects every root, so the new
pipeline code runs against real state before it merges.

Usage:
  git diff --name-only <base>...<head> | terraform_roots.py [--repo DIR]

Prints a JSON array of root directories, relative to the repository root.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# Roots the pull request plan covers: the drift-detection matrix of
# terraform-ci.yml, minus environments/preview. That root has no default for
# `postgres_egress_cidrs` on purpose (an operator states the CIDRs on a
# reviewed plan), so CI cannot plan it.
PLAN_ROOTS = (
    "infra/terraform/environments/dev",
    "infra/terraform/environments/dev-web",
    "infra/terraform/environments/staging",
    "infra/terraform/environments/staging-web",
    "infra/terraform/environments/prod",
    "infra/terraform/environments/prod-web",
    "infra/terraform/security-baseline",
    "infra/terraform/compliance-monitoring",
)

# Files that change how every root is planned or guarded.
PIPELINE_FILES = (
    ".github/workflows/terraform-ci.yml",
    ".github/workflows/terraform-apply.yml",
    "infra/terraform/scripts/plan_guard.py",
    "infra/terraform/scripts/terraform_roots.py",
)

_SOURCE = re.compile(r'^\s*source\s*=\s*"(\.\.?/[^"]+)"', re.MULTILINE)


def local_modules(directory: Path, repo: Path, seen: set[Path] | None = None) -> set[str]:
    """Every local module directory that `directory` calls, recursively."""
    seen = set() if seen is None else seen
    found: set[str] = set()
    for tf in sorted(directory.glob("*.tf")):
        for source in _SOURCE.findall(tf.read_text(encoding="utf-8")):
            module = (directory / source).resolve()
            if module in seen or not module.is_dir():
                continue
            seen.add(module)
            found.add(module.relative_to(repo).as_posix())
            found |= local_modules(module, repo, seen)
    return found


def affected_roots(changed: list[str], repo: Path) -> list[str]:
    changed = [path.strip() for path in changed if path.strip()]
    if any(path in PIPELINE_FILES for path in changed):
        return list(PLAN_ROOTS)
    out = []
    for root in PLAN_ROOTS:
        prefixes = [root, *sorted(local_modules(repo / root, repo.resolve()))]
        if any(path == prefix or path.startswith(prefix + "/") for path in changed for prefix in prefixes):
            out.append(root)
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[3]))
    args = parser.parse_args(argv)
    print(json.dumps(affected_roots(sys.stdin.read().splitlines(), Path(args.repo).resolve())))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
