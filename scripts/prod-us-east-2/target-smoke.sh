#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix/prod-us-east-2-migration}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-east-2}"

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
TARGET_DATABASE_URL="$(
  jq -er '.target_database_url // .DATABASE_URL' <<<"$target_secret_json"
)"
export TARGET_SUPABASE_URL
TARGET_SUPABASE_URL="$(
  jq -er '.target_supabase_url // .SUPABASE_URL' <<<"$target_secret_json"
)"
export TARGET_ANON_KEY
TARGET_ANON_KEY="$(
  jq -er '.target_anon_key // .SUPABASE_ANON_KEY' <<<"$target_secret_json"
)"
export TARGET_SERVICE_ROLE_KEY
TARGET_SERVICE_ROLE_KEY="$(
  jq -er '.target_service_role_key // .SUPABASE_SERVICE_ROLE_KEY' \
    <<<"$target_secret_json"
)"
export TARGET_API_URL
TARGET_API_URL="${TARGET_API_URL:-https://api-use2-shadow.kortix.com}"
export TARGET_FRONTEND_URL
TARGET_FRONTEND_URL="${TARGET_FRONTEND_URL:-https://us.kortix.com}"
export TARGET_AUTH_SEQUENCE_HEADROOM
TARGET_AUTH_SEQUENCE_HEADROOM="${TARGET_AUTH_SEQUENCE_HEADROOM:-100000000}"
export KEEP_TARGET_AUTH_SEQUENCE_HEADROOM
KEEP_TARGET_AUTH_SEQUENCE_HEADROOM="${KEEP_TARGET_AUTH_SEQUENCE_HEADROOM:-1}"

node "$(dirname "$0")/target-smoke.mjs"
