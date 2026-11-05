#!/usr/bin/env python3
"""Fail when a non-prod dotenvx profile reaches the prod stack: a value that equals its
apps/api/.env.prod value, a credential DSN that points at a production host, or a LIVE
Stripe key.

Called by scripts/e2e-secrets-envs.sh (pnpm test:envs). Tracked exceptions live in
scripts/secrets-shared-with-prod.allowlist — every entry is a debt with a reason.

The key name never decides. `DATABASE_URL`, `SUPABASE_URL` and `KORTIX_URL` carry
production reach with no KEY/SECRET/TOKEN in the name. So every key in a non-prod profile
is compared by VALUE against prod, whether or not prod defines that key. A green run
proves the comparison happened: an undecrypted prod file fails instead of passing.

Only a credential DSN reaches prod: a scheme://user:pass@host value authenticates against
the deployment it points at. The host value rule fires there and nowhere else. A bare host
name is not a reach into prod, so CLOUDFLARE_ZONE_NAME=kortix.com, hi@kortix.com and a CORS
origin list in a dev profile do not fail: the value track still compares them to prod.
"""
import json, os, re, subprocess, sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DX = sys.argv[1] if len(sys.argv) > 1 else "dotenvx"
PROFILES = [("local", "apps/api/.env"), ("dev", "apps/api/.env.dev"), ("stage", "apps/api/.env.staging")]
PROD = "apps/api/.env.prod"

# Hosts that ARE the production stack, checked only in a credential DSN (see prod_origin).
# dev.kortix.com and dev-api.kortix.com are their own environments, so only an exact match.
PROD_HOSTS = ("kortix.com", "www.kortix.com", "api.kortix.com")


def load(rel: str) -> dict | None:
    """The decrypted profile, or None when it did not decrypt.

    dotenvx exits 0 and prints the file as-is when the private key is missing, leaving
    every `encrypted:` value as ciphertext, so the exit code proves nothing. Only a
    parsed JSON object with no `encrypted:` value proves the file decrypted.
    """
    # Isolate the shell environment: `dotenvx get` lets an exported variable shadow
    # the file value, which would silently compare the wrong values.
    clean = {k: v for k, v in os.environ.items() if k == "PATH" or k.startswith("HOME")}
    out = subprocess.run([DX, "get", "-f", str(ROOT / rel), "--format", "json"], capture_output=True, text=True, env=clean).stdout
    start = next((i for i, c in enumerate(out) if c in "{["), -1)
    if start < 0:
        return None
    values = json.loads(out[start:])
    if any(str(v).startswith("encrypted:") for v in values.values()):
        return None
    return values


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
    """What in the value reaches prod, or '' — a prod host in a credential DSN, a LIVE Stripe key.

    Only a DSN with credentials (scheme://user:pass@host) carries the deployment it points
    at: that connection authenticates against the prod database. A bare host name
    (CLOUDFLARE_ZONE_NAME=kortix.com), a sender address (hi@kortix.com) and an origin
    list (CORS_ALLOWED_ORIGINS, no user:pass@) name the prod brand, not prod data, and
    dev legitimately serves them.
    """
    if value.startswith(("sk_live_", "pk_live_")):
        return "a LIVE Stripe key"
    for token in re.split(r"[\s,;]+", value):
        if len(token) > 2048:
            token = token[:2048]
        # Credential DSN: userinfo with a password (`user:pw@`, `:pw@`), not a bare host.
        if not re.match(r"^[a-z][a-z0-9+.-]*://[^/@\s]*:[^/@\s]+@", token):
            continue
        host = (urlsplit(token).hostname or "").lower()
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
    # A prod value that did not decrypt is ciphertext and can never equal a plaintext value,
    # so the `== prod value` track would pass vacuously. Refuse the green run instead: it
    # must prove the comparison happened.
    prod_file = load(PROD)
    if prod_file is None:
        print(
            f"✗ {PROD} did not decrypt (set DOTENV_PRIVATE_KEY_PROD or apps/api/.env.keys) — the value comparison cannot run",
            file=sys.stderr,
        )
        return 1
    prod = {str(v) for v in prod_file.values() if v}
    allow = allowlist()
    print("SEPARATION — no value in a non-prod profile may equal or name the prod stack:\n")
    failed = 0
    for label, rel in PROFILES:
        bad = allowed = 0
        for key, raw in sorted((load(rel) or {}).items()):
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
