#!/usr/bin/env bash

set -euo pipefail

ENVIRONMENT="${1:?environment required: dev|staging|prod}"
case "$ENVIRONMENT" in
  dev|staging)
    AWS_REGION="us-west-2"
    ;;
  prod)
    AWS_REGION="eu-west-2"
    ;;
  *)
    echo "unknown environment: $ENVIRONMENT" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRET_NAME="kortix-${ENVIRONMENT}-web-env"
PAYLOAD="$(node "$REPO_ROOT/infra/scripts/render-web-env.mjs" "$ENVIRONMENT")"
KEY_COUNT="$(printf '%s' "$PAYLOAD" | jq 'keys | length')"

if aws secretsmanager describe-secret \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  printf '%s' "$PAYLOAD" | aws secretsmanager put-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$SECRET_NAME" \
    --secret-string file:///dev/stdin >/dev/null
else
  printf '%s' "$PAYLOAD" | aws secretsmanager create-secret \
    --region "$AWS_REGION" \
    --name "$SECRET_NAME" \
    --description "Kortix ${ENVIRONMENT} web runtime environment" \
    --secret-string file:///dev/stdin >/dev/null
fi

unset PAYLOAD
echo "Synced $KEY_COUNT allowlisted values to $SECRET_NAME in $AWS_REGION."
