#!/usr/bin/env python3
"""Fail when a non-prod dotenvx profile reaches the prod stack: a value that equals its
apps/api/.env.prod value, a credential DSN that points at a production host, or a LIVE
Stripe key.

Called by scripts/e2e-secrets-envs.sh (pnpm test:envs). Tracked exceptions live in
scripts/secrets-shared-with-prod.allowlist — an entry waives the shared-value class only.

The key name never decides. `DATABASE_URL`, `SUPABASE_URL` and `KORTIX_URL` carry
production reach with no KEY/SECRET/TOKEN in the name. So every key in a non-prod profile
is compared by VALUE against prod, whether or not prod defines that key. A green run
proves the comparison happened: an undecrypted profile fails instead of passing.

Only a credential DSN reaches prod: a scheme://userinfo@host value (a user:pass pair, or a
token alone) authenticates against the deployment it points at. The host value rule fires
there and nowhere else. A bare host name is not a reach into prod, so
CLOUDFLARE_ZONE_NAME=kortix.com, hi@kortix.com and a CORS origin list in a dev profile do
not fail: the value track still compares them to prod.
A bare boolean (true/false) is also exempt: every environment's flag holds the same string
and no credential can be one.
"""
import json, os, re, subprocess, sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
DX = sys.argv[1] if len(sys.argv) > 1 else "dotenvx"
PROFILES = [("local", "apps/api/.env"), ("dev", "apps/api/.env.dev"), ("stage", "apps/api/.env.staging")]
PROD = "apps/api/.env.prod"
# A credential DSN names its deployment's host: the userinfo authenticates, as a password
# (postgres://user:pw@host) or as a token alone (https://token@host, the shape of
# BETTERSTACK_API_SENTRY_DSN in the real dev and staging profiles). The scheme is
# case-insensitive (a POSTGRES:// token is the same credential) and the userinfo may hold
# any non-space, non-slash, non-@ character, quotes included.
DSN_RE = re.compile(r"^[a-z][a-z0-9+.-]*://[^/@\s]+@", re.IGNORECASE)

# Every host under the production apex IS the production stack (supa., gateway., prod-fe-ecs.,
# ...), whatever the label. These are their own environments despite the apex, and a local
# *.kortix.internal name is neither.
PROD_APEX = "kortix.com"
NON_PROD_HOSTS = ("dev.kortix.com", "dev-api.kortix.com", "staging.kortix.com", "staging-api.kortix.com")
NON_PROD_SUFFIXES = (".kortix.internal",)


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

    Only a DSN with credentials (scheme://userinfo@host, a password or a token alone)
    carries the deployment it points at: that connection authenticates against the prod
    database. A bare host name (CLOUDFLARE_ZONE_NAME=kortix.com), a sender address
    (hi@kortix.com) and an origin list (CORS_ALLOWED_ORIGINS, no userinfo@) name the prod
    brand, not prod data, and dev legitimately serves them. The host is read the way a URL client reads it, and an
    unknown label under the apex is prod: a new supa.kortix.com fails until it is listed.
    """
    if value.startswith(("sk_live_", "pk_live_")):
        return "a LIVE Stripe key"
    # Scan the whole value, truncated never: a DSN at the tail of a long value is denied
    # nowhere else. Tokens split on whitespace, `;` and `|`; a comma splits only when it is
    # followed by a scheme://, so a password holding a raw comma stays inside its own token.
    for token in re.split(r"[\s;|]+|,(?=[a-zA-Z][a-zA-Z0-9+.-]*://)", value):
        token = token.strip(" \"'")
        if not DSN_RE.match(token):
            continue
        host = (urlsplit(token).hostname or "").lower().rstrip(".")
        if host in NON_PROD_HOSTS or host.endswith(NON_PROD_SUFFIXES):
            continue
        if host == PROD_APEX or host.endswith("." + PROD_APEX):
            return host
    return ""


def classify(value: str, prod: set) -> tuple[str, str]:
    """('', '') when the value keeps to its own environment, else (class, reason) it reaches prod."""
    if value in ("true", "false"):
        # A bare boolean is the same string in every environment and carries no credential
        # channel; comparing it would flag every feature flag prod and a non-prod profile
        # share. It is a value-class exemption, not a key-name one: a 'true' can never
        # reach a prod host either.
        return "", ""
    host = prod_origin(value)
    if host:
        return "prod-reach", f"names {host}"
    if value in prod:
        return "shared-value", "== prod value"
    return "", ""


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
        # A profile that did not decrypt is ciphertext: comparing against it compares
        # against nothing and reports a green separation it never proved. Refuse it the
        # way the prod refusal above does, so a green run proves every profile compared.
        env = load(rel)
        if env is None:
            print(f"  ✗ {label:5} {rel} did not decrypt — the value comparison cannot run")
            failed += 1
            continue
        bad = allowed = 0
        for key, raw in sorted(env.items()):
            value = str(raw)
            if not value or key.startswith("DOTENV_PUBLIC_KEY"):
                continue
            cls, why = classify(value, prod)
            if not why:
                continue
            # An allowlist entry waives ONLY the class it was granted for: a value shared with
            # prod. Naming a prod host or carrying a LIVE key is never waived, so no entry can
            # silently authorise the classes it was not reviewed for.
            if cls == "shared-value" and key in allow:
                allowed += 1
                print(f"  ~ {label:5} {key:28} {why} (allowlisted: {allow[key]})")
            else:
                bad += 1
                hint = "split it" if cls == "prod-reach" else "split it, or add it to scripts/secrets-shared-with-prod.allowlist with a reason"
                print(f"  ✗ {label:5} {key:28} {why} — {hint}")
        print(f"  {'✓' if bad == 0 else '✗'} {label:5} {bad} unallowed, {allowed} allowlisted matches with prod\n")
        failed += bad
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
