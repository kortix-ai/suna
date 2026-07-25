#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix/prod-us-west-2-migration}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-west-2}"

for command_name in aws jq node psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

target_secret_json="$(
  aws secretsmanager get-secret-value \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$TARGET_AWS_REGION" \
    --query SecretString \
    --output text
)"

export TARGET_DATABASE_URL
TARGET_DATABASE_URL="$(jq -er '.target_database_url' <<<"$target_secret_json")"
export TARGET_SUPABASE_URL
TARGET_SUPABASE_URL="$(jq -er '.target_supabase_url' <<<"$target_secret_json")"
export TARGET_ANON_KEY
TARGET_ANON_KEY="$(jq -er '.target_anon_key' <<<"$target_secret_json")"
export TARGET_SERVICE_ROLE_KEY
TARGET_SERVICE_ROLE_KEY="$(jq -er '.target_service_role_key' <<<"$target_secret_json")"
export TARGET_API_URL
TARGET_API_URL="${TARGET_API_URL:-https://api-usw2-shadow.kortix.com}"

node "$(dirname "$0")/target-smoke.mjs"
