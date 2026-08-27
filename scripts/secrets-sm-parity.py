#!/usr/bin/env python3
"""Keep apps/api/.env.<env> (dotenvx, git) identical to the env's AWS Secrets Manager blob.

    python3 scripts/secrets-sm-parity.py check [dev|staging|prod ...]   # report + exit 1 on drift
    python3 scripts/secrets-sm-parity.py pull  [dev|staging|prod ...]   # SM -> file for missing/differing keys

Runtime truth is the SM blob (ECS delivers it as KORTIX_ENV_JSON) plus the few plain
environment entries on the API task definition. The file must contain every such
key with the same value, except the prod-identical secrets in
scripts/secrets-sm-quarantine.allowlist (too privileged for a shared file) and the
names in scripts/secrets-sm-excluded.allowlist (forbidden in git by a repo guard),
which stay out of the files on purpose. Keys allowed to exist only in the file are listed in
scripts/secrets-file-only.allowlist. Needs an MFA session:
AWS_PROFILE (default kortix-mfa) and the dotenvx private keys. Prints key names
only, never values.
"""
import json, os, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENVS = {"dev": ("kortix-dev-env", "us-west-2"), "staging": ("kortix-staging-env", "us-west-2"), "prod": ("kortix-prod-env", "eu-west-2")}
# ECS API service per env: plain task-definition env vars are the second (small) runtime source.
ECS = {"dev": ("kortix-dev", "kortix-dev", "us-west-2"), "staging": ("kortix-staging", "kortix-staging", "us-west-2"), "prod": ("kortix-prod", "kortix-prod", "eu-west-2")}
ECS_IGNORE = {"KORTIX_VERSION", "PORT"}  # stamped per rollout / local listen port
DX = os.environ.get("DOTENVX", str(ROOT / "node_modules/.bin/dotenvx") if (ROOT / "node_modules/.bin/dotenvx").exists() else "dotenvx")
AWS_ENV = {**os.environ, "AWS_PROFILE": os.environ.get("AWS_PROFILE", "kortix-mfa")}
# `dotenvx get` lets an exported shell variable shadow the file value, and `dotenvx set`
# no-ops when the shell already holds that value. Every dotenvx call runs with a bare env.
CLEAN_ENV = {k: v for k, v in os.environ.items() if k == "PATH" or k.startswith("HOME")}


def file_values(env: str) -> dict:
    out = subprocess.run([DX, "get", "-f", str(ROOT / f"apps/api/.env.{env}"), "--format", "json"], capture_output=True, text=True, env=CLEAN_ENV).stdout
    start = out.find("{")
    if start < 0:
        sys.exit(f"cannot decrypt apps/api/.env.{env} (dotenvx keys?)")
    return {k: str(v) for k, v in json.loads(out[start:]).items() if not k.startswith("DOTENV_PUBLIC_KEY")}


def sm_values(env: str) -> dict:
    sid, region = ENVS[env]
    r = subprocess.run(["aws", "secretsmanager", "get-secret-value", "--secret-id", sid, "--region", region, "--query", "SecretString", "--output", "text"], capture_output=True, text=True, env=AWS_ENV)
    if r.returncode:
        sys.exit(f"{sid}: {r.stderr.strip()[:200]}")
    return {k: str(v) for k, v in json.loads(r.stdout).items()}


def ecs_values(env: str) -> dict:
    """Plain `environment` entries of the env's API task definition (never the SM-backed secrets)."""
    cluster, service, region = ECS[env]
    r = subprocess.run(["aws", "ecs", "describe-services", "--cluster", cluster, "--services", service, "--region", region, "--query", "services[0].taskDefinition", "--output", "text"], capture_output=True, text=True, env=AWS_ENV)
    if r.returncode:
        print(f"  (ecs overlay skipped for {env}: {r.stderr.strip()[:120]})"); return {}
    td = r.stdout.strip()
    r = subprocess.run(["aws", "ecs", "describe-task-definition", "--task-definition", td, "--region", region, "--query", "taskDefinition.containerDefinitions[0].environment", "--output", "json"], capture_output=True, text=True, env=AWS_ENV)
    if r.returncode:
        print(f"  (ecs overlay skipped for {env}: {r.stderr.strip()[:120]})"); return {}
    return {e["name"]: str(e["value"]) for e in json.loads(r.stdout) if e["name"] not in ECS_IGNORE}


def read_allowlist(name: str) -> dict:
    allow = {}
    for line in (ROOT / "scripts" / name).read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            k, _, why = line.partition(" ")
            allow[k] = why.strip()
    return allow


def quarantined() -> dict:
    """Prod-identical secrets kept out of the shared non-prod files (see the allowlist)."""
    return read_allowlist("secrets-sm-quarantine.allowlist")


def excluded() -> dict:
    """Keys a repository guard forbids in any tracked env file (see the allowlist)."""
    return read_allowlist("secrets-sm-excluded.allowlist")


def file_only_allow() -> dict:
    allow = {}
    for line in (ROOT / "scripts/secrets-file-only.allowlist").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            k, _, why = line.partition(" ")
            allow[k] = why.strip()
    return allow


def compare(env: str):
    f, s = file_values(env), sm_values(env)
    s = {**s, **ecs_values(env)}  # task-definition plain env wins over the blob, as in ECS
    s = {k: v for k, v in s.items() if v != ""}  # an empty SM value is satisfied by absence
    quar = {**excluded(), **(quarantined() if env != "prod" else {})}
    held = sorted(k for k in s if k in quar)  # deliberately absent from the shared file
    missing = sorted(k for k in s if k not in f and k not in quar)
    differ = sorted(k for k in s if k in f and f[k] != s[k] and k not in quar)
    extra = sorted(k for k in f if k not in s)
    return f, s, missing, differ, extra, held


def check(envs) -> int:
    allow = file_only_allow()
    failed = False
    quar = {**quarantined(), **excluded()}
    for env in envs:
        f, s, missing, differ, extra, held = compare(env)
        unlisted_extra = [k for k in extra if k not in allow]
        ok = not missing and not differ and not unlisted_extra
        failed |= not ok
        print(f"{'✓' if ok else '✗'} {env:8} file={len(f)} sm={len(s)} identical={len(s) - len(missing) - len(differ) - len(held)} missing-in-file={len(missing)} differ={len(differ)} file-only={len(extra)} (unlisted {len(unlisted_extra)}) quarantined={len(held)}")
        for k in held: print(f"    quarantined     : {k} — {quar[k]}")
        for k in missing: print(f"    missing in file : {k}")
        for k in differ:  print(f"    differs         : {k}")
        for k in unlisted_extra: print(f"    file-only, not in scripts/secrets-file-only.allowlist : {k}")
    return 1 if failed else 0


def pull(envs) -> int:
    for env in envs:
        f, s, missing, differ, extra, held = compare(env)
        target = ROOT / f"apps/api/.env.{env}"
        for k in missing + differ:
            r = subprocess.run([DX, "set", k, s[k], "-f", str(target)], capture_output=True, text=True, env=CLEAN_ENV)
            if r.returncode:
                sys.exit(f"{env}: dotenvx set {k} failed: {r.stderr.strip()[:200]}")
        print(f"{env:8} pulled {len(missing)} missing + {len(differ)} differing keys from SM into apps/api/.env.{env}" + (f" (held back {len(held)} quarantined)" if held else ""))
    return check(envs)


if __name__ == "__main__":
    args = sys.argv[1:]
    mode = args[0] if args and args[0] in ("check", "pull") else "check"
    envs = [a for a in args[1:] if a in ENVS] or list(ENVS)
    sys.exit(pull(envs) if mode == "pull" else check(envs))
