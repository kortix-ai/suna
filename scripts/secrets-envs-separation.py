#!/usr/bin/env python3
"""Fail when a secret in a non-prod dotenvx profile equals its apps/api/.env.prod value.

Called by scripts/e2e-secrets-envs.sh (pnpm test:envs). Tracked exceptions live in
scripts/secrets-shared-with-prod.allowlist — every entry is a debt with a reason.
"""
import json, os, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DX = sys.argv[1] if len(sys.argv) > 1 else "dotenvx"
SECRET_RE = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL)")
PROFILES = [("local", "apps/api/.env"), ("dev", "apps/api/.env.dev"), ("stage", "apps/api/.env.staging")]
PROD = "apps/api/.env.prod"


def load(rel: str) -> dict:
    # Isolate the shell environment: `dotenvx get` lets an exported variable shadow
    # the file value, which would silently compare the wrong values.
    clean = {k: v for k, v in os.environ.items() if k == "PATH" or k.startswith("HOME")}
    out = subprocess.run([DX, "get", "-f", str(ROOT / rel), "--format", "json"], capture_output=True, text=True, env=clean).stdout
    start = out.find("{")
    return json.loads(out[start:]) if start >= 0 else {}


def allowlist() -> dict:
    allow = {}
    for line in (ROOT / "scripts/secrets-shared-with-prod.allowlist").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, why = line.partition(" ")
        allow[key] = why.strip()
    return allow


def main() -> int:
    prod = load(PROD)
    allow = allowlist()
    failed = False
    print("SEPARATION — no secret in a non-prod profile may equal its apps/api/.env.prod value:\n")
    for label, rel in PROFILES:
        cur = load(rel)
        bad = allowed = 0
        for key in sorted(cur):
            value = str(cur[key])
            if not value or key.startswith("DOTENV_PUBLIC_KEY") or not SECRET_RE.search(key):
                continue
            if str(prod.get(key, "")) != value:
                continue
            if key in allow:
                allowed += 1
                print(f"  ~ {label:5} {key:28} == prod (allowlisted: {allow[key]})")
            else:
                bad += 1
                print(f"  ✗ {label:5} {key:28} == prod value — split it, or add it to scripts/secrets-shared-with-prod.allowlist with a reason")
        mark = "✓" if bad == 0 else "✗"
        print(f"  {mark} {label:5} {bad} unallowed, {allowed} allowlisted matches with prod\n")
        failed |= bad > 0
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
