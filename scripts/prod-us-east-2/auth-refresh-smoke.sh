#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_SECRET_ID="${SOURCE_SECRET_ID:-kortix-prod-env}"
SOURCE_AWS_REGION="${SOURCE_AWS_REGION:-eu-west-2}"
TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix/prod-us-east-2-migration}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-east-2}"

if [[ "${ALLOW_SOURCE_AUTH_REFRESH_SMOKE:-}" != "1" ]]; then
  echo "Set ALLOW_SOURCE_AUTH_REFRESH_SMOKE=1 to run the source Auth refresh smoke." >&2
  exit 64
fi

for command_name in aws jq node psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

source_secret_json="$(
  aws secretsmanager get-secret-value \
    --secret-id "$SOURCE_SECRET_ID" \
    --region "$SOURCE_AWS_REGION" \
    --query SecretString \
    --output text
)"
target_secret_json="$(
  aws secretsmanager get-secret-value \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$TARGET_AWS_REGION" \
    --query SecretString \
    --output text
)"

export SOURCE_DATABASE_URL
SOURCE_DATABASE_URL="$(jq -er '.DATABASE_URL' <<<"$source_secret_json")"
export SOURCE_SUPABASE_URL
SOURCE_SUPABASE_URL="$(jq -er '.SUPABASE_URL' <<<"$source_secret_json")"
export SOURCE_ANON_KEY
SOURCE_ANON_KEY="$(jq -er '.SUPABASE_ANON_KEY' <<<"$source_secret_json")"

export TARGET_DATABASE_URL
TARGET_DATABASE_URL="$(jq -er '.target_database_url' <<<"$target_secret_json")"
export TARGET_SUPABASE_URL
TARGET_SUPABASE_URL="$(jq -er '.target_supabase_url' <<<"$target_secret_json")"
export TARGET_ANON_KEY
TARGET_ANON_KEY="$(jq -er '.target_anon_key' <<<"$target_secret_json")"

node "$(dirname "$0")/auth-refresh-smoke.mjs"
