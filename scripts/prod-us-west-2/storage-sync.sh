#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_SECRET_ID="${SOURCE_SECRET_ID:-kortix-prod-env}"
SOURCE_AWS_REGION="${SOURCE_AWS_REGION:-eu-west-2}"
TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix/prod-us-west-2-migration}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-west-2}"

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
export SOURCE_SERVICE_ROLE_KEY
SOURCE_SERVICE_ROLE_KEY="$(jq -er '.SUPABASE_SERVICE_ROLE_KEY' <<<"$source_secret_json")"
export TARGET_DATABASE_URL
TARGET_DATABASE_URL="$(
  jq -er '.target_database_url // .DATABASE_URL' <<<"$target_secret_json"
)"
export TARGET_SUPABASE_URL
TARGET_SUPABASE_URL="$(
  jq -er '.target_supabase_url // .SUPABASE_URL' <<<"$target_secret_json"
)"
export TARGET_SERVICE_ROLE_KEY
TARGET_SERVICE_ROLE_KEY="$(
  jq -er \
    '.target_service_role_key // .SUPABASE_SERVICE_ROLE_KEY' \
    <<<"$target_secret_json"
)"

node "$(dirname "$0")/storage-sync.mjs"
