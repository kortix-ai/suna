#!/usr/bin/env python3
"""Standalone helper to apply Supabase migrations outside the full setup wizard."""

from __future__ import annotations

import argparse
import os
import platform
import re
import subprocess
import sys
from pathlib import Path
import textwrap

IS_WINDOWS = platform.system() == "Windows"


def parse_env_file(filepath: Path) -> dict[str, str]:
    """Returns a dictionary of key/value pairs from a .env formatted file."""
    env_vars: dict[str, str] = {}
    try:
        with filepath.open(encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                env_vars[key] = value
    except FileNotFoundError:
        pass
    return env_vars


def run_supabase_command(
    command: list[str],
    backend_dir: Path,
    description: str,
) -> None:
    """Runs a Supabase CLI command and reports errors with context."""
    try:
        print(f"\n▶ {description}")
        print("  " + " ".join(command))
        subprocess.run(
            command,
            cwd=str(backend_dir),
            check=True,
            shell=IS_WINDOWS,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "Node.js/npm or Supabase CLI not found. Install Node.js and retry."
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"{description} failed (exit code {exc.returncode})."
        ) from exc


def ensure_supabase_cli(backend_dir: Path) -> None:
    """Verifies that the Supabase CLI can be invoked."""
    run_supabase_command(
        ["npx", "supabase", "--version"],
        backend_dir,
        "Checking Supabase CLI",
    )


def determine_project_ref(env: dict[str, str], supabase_url: str) -> str | None:
    """Returns a Supabase project reference, falling back to the URL if needed."""
    ref = env.get("SUPABASE_PROJECT_REF")
    if ref:
        return ref

    match = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
    return match.group(1) if match else None


def apply_local_migrations(backend_dir: Path) -> None:
    """Runs Supabase migrations against a locally hosted Supabase instance."""
    ensure_supabase_cli(backend_dir)
    run_supabase_command(
        ["npx", "supabase", "status"],
        backend_dir,
        "Checking local Supabase services",
    )
    print(
        "\n⚠️  Make sure your local Supabase services are running before resetting the database."
    )
    run_supabase_command(
        ["npx", "supabase", "db", "reset"],
        backend_dir,
        "Resetting local Supabase and applying migrations",
    )
    print("✅ Local Supabase migrations applied.\n")


def apply_cloud_migrations(
    backend_dir: Path,
    project_ref: str,
    token: str | None,
    skip_login: bool,
    skip_link: bool,
) -> None:
    """Runs Supabase migrations against a cloud project."""
    ensure_supabase_cli(backend_dir)

    if not skip_login:
        command = ["npx", "supabase", "login"]
        if token:
            command += ["--token", token]
        run_supabase_command(
            command,
            backend_dir,
            "Authenticating Supabase CLI",
        )
    else:
        print("\nℹ️  Skipping Supabase login as requested.")

    if not skip_link:
        run_supabase_command(
            ["npx", "supabase", "link", "--project-ref", project_ref],
            backend_dir,
            f"Linking Supabase project '{project_ref}'",
        )
    else:
        print("\nℹ️  Skipping `supabase link` because it was already configured.")

    run_supabase_command(
        ["npx", "supabase", "db", "push"],
        backend_dir,
        "Pushing Supabase migrations",
    )

    print(textwrap.dedent("""
    ✅ Cloud Supabase schema push complete.
    ⚠️  Please expose the 'basejump' schema in the Supabase dashboard (Project Settings → API → Exposed Schemas).
    """))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run Supabase migrations without re-running the full setup wizard."
    )
    parser.add_argument(
        "--target",
        choices=["cloud", "local"],
        help="Explicitly choose whether to target a cloud project or a local Supabase instance.",
    )
    parser.add_argument(
        "--token",
        help="Supabase access token for non-interactive CLI login (falls back to SUPABASE_ACCESS_TOKEN env var).",
    )
    parser.add_argument(
        "--project-ref",
        help="Override the Supabase project reference (e.g., 'jwnskwnoistiunvbcaam').",
    )
    parser.add_argument(
        "--backend-dir",
        default="backend",
        help="Path to the backend directory that contains supabase/config.toml and migrations.",
    )
    parser.add_argument(
        "--skip-login",
        action="store_true",
        help="Skip Supabase CLI login (useful if you are already logged in).",
    )
    parser.add_argument(
        "--skip-link",
        action="store_true",
        help="Skip linking the Supabase project (if already linked).",
    )

    args = parser.parse_args()

    backend_dir = Path(args.backend_dir)
    if not backend_dir.is_dir():
        print(f"❌  Backend directory not found: {backend_dir}")
        sys.exit(1)

    env_path = backend_dir / ".env"
    env = parse_env_file(env_path)
    supabase_url = env.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL")
    if not supabase_url:
        print(
            "❌  SUPABASE_URL not found in backend/.env. Please run the wizard or set it manually."
        )
        sys.exit(1)

    target = args.target
    if not target:
        target = (
            "local"
            if supabase_url.startswith("http://localhost")
            or supabase_url.startswith("http://127.0.0.1")
            else "cloud"
        )
        print(f"ℹ️  Auto-detected target: {target}")

    token = args.token or os.environ.get("SUPABASE_ACCESS_TOKEN")

    if target == "local":
        apply_local_migrations(backend_dir)
        return

    project_ref = args.project_ref or determine_project_ref(env, supabase_url)
    if not project_ref:
        print(
            "❌  Could not determine Supabase project reference. Provide --project-ref or set SUPABASE_PROJECT_REF in backend/.env."
        )
        sys.exit(1)

    apply_cloud_migrations(
        backend_dir,
        project_ref,
        token,
        skip_login=args.skip_login,
        skip_link=args.skip_link,
    )


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as exc:
        print(f"❌  {exc}")
        sys.exit(1)