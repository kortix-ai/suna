#!/usr/bin/env bash

set -euo pipefail

ENVIRONMENT="${1:?environment required: dev|staging|prod}"
case "$ENVIRONMENT" in
  dev)
    # infra/terraform/environments/dev-web-us-east-2 reads this secret.
    AWS_REGION="us-east-2"
    SECRET_NAME="kortix-dev-use2-web-env"
    ;;
  staging)
    # infra/terraform/environments/staging-web-eu-west-2 reads this secret.
    AWS_REGION="eu-west-2"
    SECRET_NAME="kortix-staging-euw2-web-env"
    ;;
  prod)
    AWS_REGION="eu-west-2"
    ;;
  *)
    echo "unknown environment: $ENVIRONMENT" >&2
    exit 2
    ;;
esac

# shellcheck source=infra/scripts/lib/aws-secret.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/aws-secret.sh"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRET_NAME="${SECRET_NAME:-kortix-${ENVIRONMENT}-web-env}"
PAYLOAD="$(node "$REPO_ROOT/infra/scripts/render-web-env.mjs" "$ENVIRONMENT")"
KEY_COUNT="$(printf '%s' "$PAYLOAD" | jq 'keys | length')"

printf '%s' "$PAYLOAD" | put_or_create_secret "$AWS_REGION" "$SECRET_NAME" "Kortix ${ENVIRONMENT} web runtime environment" >/dev/null

unset PAYLOAD
echo "Synced $KEY_COUNT allowlisted values to $SECRET_NAME in $AWS_REGION."
