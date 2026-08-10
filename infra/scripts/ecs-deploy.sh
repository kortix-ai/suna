#!/usr/bin/env bash
#
# ecs-deploy.sh — roll a Kortix service onto ECS Fargate with a task-def rendered
# fresh from Secrets Manager, so task-definition revisions cannot drift.
#
# The env contract lives in ONE place per environment: the Secrets Manager blob
# `kortix-<env>-env`. ECS injects the complete JSON document through one stable
# selector. Application startup expands it into process.env. Adding or removing
# an optional JSON key cannot invalidate an already-registered task definition.
#
# Usage:
#   ecs-deploy.sh <env> <image> [--service api|gateway|web] [--version X.Y.Z]
#                 [--database-migrated] [--no-wait] [--dry-run]
#
#   env        dev | staging | prod | prod-use2-shadow
#   image      full image ref to pin, e.g. kortix/kortix-api:dev-481dc551
#   --version  explicit KORTIX_VERSION to stamp into the task-def env. When
#              omitted, it is DERIVED from the image tag if the tag is a clean
#              release version (X.Y.Z). Why: prod release images are RETAGGED
#              staging manifests, so their baked KORTIX_VERSION is the staging
#              string (e.g. 0.9.109-staging.<sha8>) — without this stamp, ECS
#              /v1/health reports that instead of the released X.Y.Z. The stamp
#              lets deploy-prod assert that the public endpoint serves the
#              released version.
#   --dry-run  render + print the task-def override, then exit WITHOUT
#              registering or rolling anything.
#   --database-migrated
#              required for a live prod or prod-use2-shadow rollout. This is an
#              explicit assertion that the environment's migration job passed.
#              It prevents an emergency direct ECS roll from silently bypassing
#              the database gate.
#
# Requires: awscli v2, jq. Assumes the ECS cluster/service/ALB/target-group and
# the exec/task IAM roles already exist (Terraform owns those).

set -euo pipefail

# If the image tag is a clean release version (X.Y.Z), echo it; else echo "".
# Kept a pure function so it can be unit-tested without AWS.
derive_version_from_image() {
  local tag="${1##*:}"
  if printf '%s' "$tag" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    printf '%s' "$tag"
  fi
}

configure_service_coordinates() {
  local service_kind="$1"
  VERSION_ENV_NAME="KORTIX_VERSION"
  case "$service_kind" in
    api)
      CLUSTER="$SERVICE_PREFIX"
      SERVICE="$SERVICE_PREFIX"
      CONTAINER="api"
      ;;
    gateway)
      CLUSTER="${SERVICE_PREFIX}-gateway"
      SERVICE="${SERVICE_PREFIX}-gateway"
      CONTAINER="gateway"
      ;;
    web)
      CLUSTER="${SERVICE_PREFIX}-web"
      SERVICE="${SERVICE_PREFIX}-web"
      CONTAINER="web"
      SECRET_NAME="${SERVICE_PREFIX}-web-env"
      VERSION_ENV_NAME="KORTIX_PUBLIC_VERSION"
      ;;
    *)
      echo "unknown service: $service_kind (expected api|gateway|web)" >&2
      return 2
      ;;
  esac
}

# Allow sourcing for tests: `KORTIX_ECS_DEPLOY_LIB=1 source ecs-deploy.sh`.
if [ "${KORTIX_ECS_DEPLOY_LIB:-}" = "1" ]; then
  # shellcheck disable=SC2317 # `exit` is the non-sourced fallback for `return`
  return 0 2>/dev/null || exit 0
fi

ENV="${1:?env required: dev|staging|prod|prod-use2-shadow}"
IMAGE="${2:?image required, e.g. kortix/kortix-api:dev-481dc551}"
shift 2

SVC_KIND="api"
WAIT=1
DRY_RUN=0
DATABASE_MIGRATED=0
VERSION_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SVC_KIND="$2"; shift 2 ;;
    --version) VERSION_OVERRIDE="$2"; shift 2 ;;
    --database-migrated) DATABASE_MIGRATED=1; shift ;;
    --no-wait) WAIT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$VERSION_OVERRIDE" ] || VERSION_OVERRIDE="$(derive_version_from_image "$IMAGE")"

# ── per-environment coordinates ──────────────────────────────────────────────
case "$ENV" in
  dev)
    REGION="us-west-2"
    SERVICE_PREFIX="kortix-dev"
    SECRET_NAME="kortix-dev-env"
    ;;
  staging)
    REGION="us-west-2"
    SERVICE_PREFIX="kortix-staging"
    SECRET_NAME="kortix-staging-env"
    ;;
  prod)
    REGION="eu-west-2"
    SERVICE_PREFIX="kortix-prod"
    SECRET_NAME="kortix-prod-env"
    ;;
  prod-use2-shadow)
    REGION="us-east-2"
    SERVICE_PREFIX="kortix-prod-use2"
    SECRET_NAME="kortix-prod-us-east-2-env"
    ;;
  *) echo "unknown env: $ENV" >&2; exit 2 ;;
esac

if [ "$DRY_RUN" != "1" ] \
  && { [ "$ENV" = "prod" ] || [ "$ENV" = "prod-use2-shadow" ]; } \
  && [ "$DATABASE_MIGRATED" != "1" ]; then
  echo "refusing live $ENV rollout without --database-migrated; apply and verify all database migrations first" >&2
  exit 2
fi

# Each service lives in its own cluster (the ecs-api module names cluster==service).
configure_service_coordinates "$SVC_KIND"

echo "▶ env=$ENV region=$REGION cluster=$CLUSTER service=$SERVICE container=$CONTAINER"
echo "▶ image=$IMAGE  secrets<-$SECRET_NAME"
if [ -n "$VERSION_OVERRIDE" ]; then
  echo "▶ KORTIX_VERSION=$VERSION_OVERRIDE (task-def env stamp)"
else
  echo "▶ KORTIX_VERSION: no override (non-release tag) — image's baked version reports"
fi

# ── skip gracefully if this env's ECS service isn't built yet ────────────────
# Lets the ECS-roll step live in EVERY env's CI before the staging/prod ECS infra
# exists — it no-ops until Terraform creates the cluster+service, then auto-rolls.
STATUS="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
  --services "$SERVICE" --query 'services[0].status' --output text 2>/dev/null || true)"
if [ "$STATUS" != "ACTIVE" ]; then
  echo "⏭  ECS service $CLUSTER/$SERVICE not ACTIVE (got '${STATUS:-none}') — skipping ($ENV ECS infra not built yet)."
  exit 0
fi

# ── resolve the secrets blob ARN (no hardcoded suffix) ───────────────────────
SECRET_ARN="$(aws secretsmanager describe-secret --region "$REGION" \
  --secret-id "$SECRET_NAME" --query 'ARN' --output text)"
[ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != "None" ] || { echo "secret $SECRET_NAME not found in $REGION" >&2; exit 1; }

# Validate the blob without printing it. The task definition references only the
# secret ARN, so its selector remains valid when optional keys change later.
SECRET_VALUE="$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$SECRET_ARN" --query 'SecretString' --output text)"
KEYCOUNT="$(printf '%s' "$SECRET_VALUE" | jq 'if type == "object" and all(.[]; type == "string") then length else error("secret must be a JSON object of strings") end')"
[ "$KEYCOUNT" -gt 0 ] || { echo "blob $SECRET_NAME has 0 keys — refusing to deploy" >&2; exit 1; }
unset SECRET_VALUE
SECRETS_JSON="$(jq -cn --arg arn "$SECRET_ARN" '[{name: "KORTIX_ENV_JSON", valueFrom: $arn}]')"
echo "▶ wired $KEYCOUNT environment values through KORTIX_ENV_JSON from $SECRET_NAME"

# ── base task-def = the service's current one, with runtime fields stripped ──
CURRENT_TD="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
  --services "$SERVICE" --query 'services[0].taskDefinition' --output text)"
[ -n "$CURRENT_TD" ] && [ "$CURRENT_TD" != "None" ] || { echo "service $SERVICE has no task-def" >&2; exit 1; }

NEW_TD_JSON="$(aws ecs describe-task-definition --region "$REGION" \
  --task-definition "$CURRENT_TD" --query 'taskDefinition' --output json \
  | jq --arg img "$IMAGE" --arg c "$CONTAINER" --arg ver "$VERSION_OVERRIDE" \
       --arg version_env "$VERSION_ENV_NAME" \
       --argjson secrets "$SECRETS_JSON" '
      # drop read-only fields register-task-definition rejects
      del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
          .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
      # Override image + full secrets on the target container. Stamp
      # KORTIX_VERSION as explicit container env so ECS reports the same clean
      # version EKS reports. Always remove KORTIX_COMMIT from the task
      # definition. The immutable image contains the source commit. Preserving
      # a task-definition override can make a new image report an old commit.
      # On non-release tags ($ver == ""), remove any stale version stamp so the
      # image-baked dev/staging version reports again.
      | .containerDefinitions |= map(
          if .name == $c then
            .image = $img
            | .secrets = $secrets
            | .environment = (
                ((.environment // []) | map(
                  select(
                    .name != "KORTIX_VERSION" and
                    .name != "KORTIX_PUBLIC_VERSION" and
                    .name != "NEXT_PUBLIC_KORTIX_VERSION" and
                    .name != "KORTIX_COMMIT"
                  )
                ))
                + (if $ver == "" then [] else [{name: $version_env, value: $ver}] end))
          else . end)')"

if [ "$DRY_RUN" = "1" ]; then
  echo "── dry-run: rendered task-def override for container '$CONTAINER' ──"
  echo "$NEW_TD_JSON" | jq --arg c "$CONTAINER" \
    '.containerDefinitions[] | select(.name == $c) | {image, environment, secretKeys: (.secrets | length)}'
  echo "✅ dry-run only — nothing registered, nothing rolled."
  exit 0
fi

TDFILE="$(mktemp -t ecs-td-XXXX.json)"
trap 'rm -f "$TDFILE"' EXIT
echo "$NEW_TD_JSON" > "$TDFILE"

NEW_TD="$(aws ecs register-task-definition --region "$REGION" \
  --cli-input-json "file://$TDFILE" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
echo "✔ registered $NEW_TD"

# ── roll the service ─────────────────────────────────────────────────────────
# Point the service at the new revision and force a fresh deployment. We do NOT
# change the desired count: whether ECS runs in parallel (dev/staging) or stays a
# scaled-to-zero standby (prod, until a deliberate flip) is owned by Terraform's
# desired_count / a manual scale, not by this roll.
aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_TD" --force-new-deployment >/dev/null
echo "✔ update-service issued (desired count unchanged)"

if [ "$WAIT" = "1" ]; then
  echo "⏳ waiting for services-stable …"
  aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"
  aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].{running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}' \
    --output table
fi
echo "✅ $ENV/$CONTAINER now on $IMAGE ($NEW_TD)"
