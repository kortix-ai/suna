#!/usr/bin/env bash
#
# ecs-deploy.sh — roll a Kortix service onto ECS Fargate with a task-def rendered
# fresh from Secrets Manager, so the ECS env can never drift from the EKS env.
#
# The env contract lives in ONE place per environment: the Secrets Manager blob
# `kortix-<env>-env` (the same blob external-secrets syncs into EKS). We read its
# keys and wire every one into the task-def as a `secrets` entry pointing back at
# that blob's JSON key — no hand-maintained secret list, no drift.
#
# Usage:
#   ecs-deploy.sh <env> <image> [--service api|gateway] [--no-wait]
#
#   env    dev | staging | prod
#   image  full image ref to pin, e.g. kortix/kortix-api:dev-481dc551
#
# Requires: awscli v2, jq. Assumes the ECS cluster/service/ALB/target-group and
# the exec/task IAM roles already exist (Terraform owns those).

set -euo pipefail

ENV="${1:?env required: dev|staging|prod}"
IMAGE="${2:?image required, e.g. kortix/kortix-api:dev-481dc551}"
shift 2

SVC_KIND="api"
WAIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SVC_KIND="$2"; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── per-environment coordinates ──────────────────────────────────────────────
case "$ENV" in
  dev)     REGION="us-west-2" ;;
  staging) REGION="us-west-2" ;;
  prod)    REGION="eu-west-2" ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

# Each service lives in its own cluster (the ecs-api module names cluster==service):
#   api     → cluster/service kortix-<env>,         container "api"
#   gateway → cluster/service kortix-<env>-gateway,  container "gateway"
if [ "$SVC_KIND" = "gateway" ]; then
  CLUSTER="kortix-${ENV}-gateway"
  SERVICE="kortix-${ENV}-gateway"
  CONTAINER="gateway"
else
  CLUSTER="kortix-${ENV}"
  SERVICE="kortix-${ENV}"
  CONTAINER="api"
fi
SECRET_NAME="kortix-${ENV}-env"

echo "▶ env=$ENV region=$REGION cluster=$CLUSTER service=$SERVICE container=$CONTAINER"
echo "▶ image=$IMAGE  secrets<-$SECRET_NAME"

# ── resolve the secrets blob ARN (no hardcoded suffix) ───────────────────────
SECRET_ARN="$(aws secretsmanager describe-secret --region "$REGION" \
  --secret-id "$SECRET_NAME" --query 'ARN' --output text)"
[ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != "None" ] || { echo "secret $SECRET_NAME not found in $REGION" >&2; exit 1; }

# every key in the blob -> a task-def secret entry pointing at that JSON key
SECRETS_JSON="$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$SECRET_ARN" --query 'SecretString' --output text \
  | jq --arg arn "$SECRET_ARN" '
      keys
      | map({ name: ., valueFrom: ($arn + ":" + . + "::") })')"
KEYCOUNT="$(echo "$SECRETS_JSON" | jq 'length')"
[ "$KEYCOUNT" -gt 0 ] || { echo "blob $SECRET_NAME has 0 keys — refusing to deploy" >&2; exit 1; }
echo "▶ wired $KEYCOUNT secret keys from $SECRET_NAME"

# ── base task-def = the service's current one, with runtime fields stripped ──
CURRENT_TD="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
  --services "$SERVICE" --query 'services[0].taskDefinition' --output text)"
[ -n "$CURRENT_TD" ] && [ "$CURRENT_TD" != "None" ] || { echo "service $SERVICE has no task-def" >&2; exit 1; }

NEW_TD_JSON="$(aws ecs describe-task-definition --region "$REGION" \
  --task-definition "$CURRENT_TD" --query 'taskDefinition' --output json \
  | jq --arg img "$IMAGE" --arg c "$CONTAINER" --argjson secrets "$SECRETS_JSON" '
      # drop read-only fields register-task-definition rejects
      del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
          .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
      # override image + full secrets on the target container
      | .containerDefinitions |= map(
          if .name == $c then .image = $img | .secrets = $secrets else . end)')"

TDFILE="$(mktemp -t ecs-td-XXXX.json)"
trap 'rm -f "$TDFILE"' EXIT
echo "$NEW_TD_JSON" > "$TDFILE"

NEW_TD="$(aws ecs register-task-definition --region "$REGION" \
  --cli-input-json "file://$TDFILE" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
echo "✔ registered $NEW_TD"

# ── roll the service ─────────────────────────────────────────────────────────
DESIRED="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
  --services "$SERVICE" --query 'services[0].desiredCount' --output text)"
SCALE_ARG=()
if [ "${DESIRED:-0}" -lt 1 ]; then
  echo "▶ service desired=$DESIRED → scaling to 2"
  SCALE_ARG=(--desired-count 2)
fi

aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_TD" --force-new-deployment "${SCALE_ARG[@]}" >/dev/null
echo "✔ update-service issued"

if [ "$WAIT" = "1" ]; then
  echo "⏳ waiting for services-stable …"
  aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].{running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}' \
    --output table
fi
echo "✅ $ENV/$CONTAINER now on $IMAGE ($NEW_TD)"
