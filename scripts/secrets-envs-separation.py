#!/usr/bin/env python3
"""Fail when a non-prod dotenvx profile reaches the prod stack: a value that equals its
apps/api/.env.prod value, or a URL/DSN that names a production host.

Called by scripts/e2e-secrets-envs.sh (pnpm test:envs). Tracked exceptions live in
scripts/secrets-shared-with-prod.allowlist — every entry is a debt with a reason.

The key name never decides. `DATABASE_URL`, `SUPABASE_URL` and `KORTIX_URL` carry
production reach with no KEY/SECRET/TOKEN in the name. So every key in a non-prod profile
is compared by VALUE against prod, whether or not prod defines that key, and every value's
URL host is checked against the prod hosts. Only apps/api/.env.prod may name a prod host.
"""
import json, os, re, subprocess, sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DX = sys.argv[1] if len(sys.argv) > 1 else "dotenvx"
PROFILES = [("local", "apps/api/.env"), ("dev", "apps/api/.env.dev"), ("stage", "apps/api/.env.staging")]
PROD = "apps/api/.env.prod"

# Hosts that ARE the production stack. dev.kortix.com and dev-api.kortix.com are their
# own environments, so only an exact match reaches prod.
PROD_HOSTS = ("kortix.com", "www.kortix.com", "api.kortix.com")


def load(rel: str) -> dict:
    # Isolate the shell environment: `dotenvx get` lets an exported variable shadow
    # the file value, which would silently compare the wrong values.
    clean = {k: v for k, v in os.environ.items() if k == "PATH" or k.startswith("HOME")}
    out = subprocess.run([DX, "get", "-f", str(ROOT / rel), "--format", "json"], capture_output=True, text=True, env=clean).stdout
    start = next((i for i, c in enumerate(out) if c in "{["), -1)
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


def prod_origin(value: str) -> str:
    """What in the value reaches prod, or '' — a prod host in a URL/DSN/host list, a LIVE Stripe key."""
    if value.startswith(("sk_live_", "pk_live_")):
        return "a LIVE Stripe key"
    for token in re.split(r"[\s,;]+", value):
        if len(token) > 2048:
            token = token[:2048]
        token = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://", "", token)
        host = (urlsplit("//" + token).hostname or "").lower()
        if host in PROD_HOSTS:
            return host
    return ""


def classify(value: str, prod: set) -> str:
    """'' when the value keeps to its own environment, else the reason it reaches prod."""
    host = prod_origin(value)
    if host:
        return f"names {host}"
    for other in prod:
        if value == other:
            return "== prod value"
    return ""


def main() -> int:
    prod = {str(v) for v in load(PROD).values() if v}
    allow = allowlist()
    print("SEPARATION — no value in a non-prod profile may equal or name the prod stack:\n")
    failed = 0
    for label, rel in PROFILES:
        bad = allowed = 0
        for key, raw in sorted(load(rel).items()):
            value = str(raw)
            if not value or key.startswith("DOTENV_PUBLIC_KEY"):
                continue
            why = classify(value, prod)
            if not why:
                continue
            if key in allow:
                allowed += 1
                print(f"  ~ {label:5} {key:28} {why} (allowlisted: {allow[key]})")
            else:
                bad += 1
                print(f"  ✗ {label:5} {key:28} {why} — split it, or add it to scripts/secrets-shared-with-prod.allowlist with a reason")
        print(f"  {'✓' if bad == 0 else '✗'} {label:5} {bad} unallowed, {allowed} allowlisted matches with prod\n")
        failed += bad
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
