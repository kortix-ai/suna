#!/usr/bin/env bash
# Materialize the project's secrets into a real .env file so the app's tooling
# (apps/api `--env-file`, Next.js, etc.) works in the preview.
#
# The platform injects every project secret's VALUE into the sandbox env at boot
# (buildSessionSandboxEnvVars → `...runtimeSecrets.env`), and the list of names
# in $KORTIX_PROJECT_SECRET_NAMES. We just write each NAME=VALUE to a dotenv file.
# There is no read-API for secret values from outside the sandbox — this in-boot
# env is the only place the values exist, which is exactly where the app runs.
#
# Usage:  write-env.sh [out-path]        (default: ./.env)
set -euo pipefail

OUT="${1:-.env}"
: > "$OUT"

names="${KORTIX_PROJECT_SECRET_NAMES:-}"
count=0
IFS=',' read -ra NAMES <<< "$names"
for name in "${NAMES[@]}"; do
  name="$(printf '%s' "$name" | tr -d '[:space:]')"
  [ -n "$name" ] || continue
  # Indirect expansion: value of the env var named "$name".
  printf '%s=%s\n' "$name" "${!name-}" >> "$OUT"
  count=$((count + 1))
done

printf '[pr-bot] wrote %d project secret(s) to %s\n' "$count" "$OUT" >&2
