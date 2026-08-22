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
#
# Optional non-secret task environment overrides are read from
# KORTIX_ECS_ENV_OVERRIDES as a JSON object of string values. The renderer
# replaces matching values from the running task and preserves every other
# value. Secrets remain in the aggregate Secrets Manager blob.

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

merge_environment_overrides() {
  local current="${1:-[]}" overrides="${2:-}"
  [ -n "$overrides" ] || overrides='{}'
  jq -cn --argjson current "$current" --argjson overrides "$overrides" '
    if ($current | type) != "array" or any($current[]; (.name | type) != "string" or (.value | type) != "string") then
      error("current ECS environment must be an array of string name/value objects")
    elif ($overrides | type) != "object" or any($overrides[]; type != "string") then
      error("KORTIX_ECS_ENV_OVERRIDES must be a JSON object of strings")
    elif (($overrides | keys) | all(.[]; test("^[A-Za-z_][A-Za-z0-9_]*$"))) | not then
      error("KORTIX_ECS_ENV_OVERRIDES contains an invalid environment name")
    else
      [$current[] | select(.name as $name | ($overrides | has($name) | not))]
      + [$overrides | to_entries | sort_by(.key)[] | {name: .key, value: .value}]
    end
  '
}

gateway_target_for_env() {
  case "$1" in
    dev) printf '%s' 'https://gateway-dev-ecs-fargate.kortix.com' ;;
    staging) printf '%s' 'https://gateway-staging-ecs-fargate.kortix.com' ;;
    prod) printf '%s' 'https://gateway-ecs-fargate.kortix.com' ;;
    prod-use2-shadow) printf '%s' 'https://gateway-use2-shadow.kortix.com' ;;
    *) echo "unknown gateway environment: $1" >&2; return 2 ;;
  esac
}

fast_cold_boot_requires_atomic_admission() {
  local overrides_json="${1:-}" secret_json="${2:-}"
  local enabled providers
  [ -n "$overrides_json" ] || overrides_json='{}'
  [ -n "$secret_json" ] || secret_json='{}'
  if ! enabled="$(printf '%s' "$overrides_json" | jq -er '.KORTIX_FAST_COLD_BOOT_ENABLED // "false"')"; then
    echo 'refusing deployment: malformed KORTIX_ECS_ENV_OVERRIDES JSON' >&2
    return 2
  fi
  [ "$enabled" = "true" ] || return 1
  if ! providers="$(printf '%s' "$secret_json" | jq -er '.ALLOWED_SANDBOX_PROVIDERS // "" | ascii_downcase')"; then
    echo 'refusing FAST cold boot activation: malformed environment secret JSON' >&2
    return 2
  fi
  printf '%s' "$providers" | grep -Eq '(^|[[:space:],])platinum([[:space:],]|$)'
}

validate_platinum_atomic_admission() {
  local quota_json="${1:-}"
  [ -n "$quota_json" ] || quota_json='{}'
  if printf '%s' "$quota_json" | jq -e '.templates.atomicAdmission == true' >/dev/null 2>&1; then
    return 0
  fi
  echo 'refusing FAST cold boot activation: Platinum does not advertise atomic template admission' >&2
  return 1
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

FAST_OVERRIDES_JSON="${KORTIX_ECS_ENV_OVERRIDES:-}"
[ -n "$FAST_OVERRIDES_JSON" ] || FAST_OVERRIDES_JSON='{}'
FAST_CAPABILITY_REQUIRED=0
fast_cold_boot_requires_atomic_admission "$FAST_OVERRIDES_JSON" "$SECRET_VALUE" || FAST_CAPABILITY_REQUIRED=$?
if [ "$FAST_CAPABILITY_REQUIRED" -eq 2 ]; then
  exit 1
elif [ "$FAST_CAPABILITY_REQUIRED" -eq 0 ]; then
  PLATINUM_URL="$(printf '%s' "$SECRET_VALUE" | jq -r '.PLATINUM_API_URL // empty')"
  PLATINUM_KEY="$(printf '%s' "$SECRET_VALUE" | jq -r '.PLATINUM_API_KEY // empty')"
  case "$PLATINUM_URL" in
    https://*) ;;
    *) echo 'refusing FAST cold boot activation: PLATINUM_API_URL must use https' >&2; exit 1 ;;
  esac
  [ -n "$PLATINUM_KEY" ] || { echo 'refusing FAST cold boot activation: PLATINUM_API_KEY is missing' >&2; exit 1; }

  FAST_HEADER_FILE="$(mktemp)"
  cleanup_fast_header() { rm -f -- "$FAST_HEADER_FILE"; }
  trap cleanup_fast_header EXIT
  chmod 600 "$FAST_HEADER_FILE"
  printf 'Authorization: Bearer %s\n' "$PLATINUM_KEY" > "$FAST_HEADER_FILE"
  PLATINUM_QUOTA="$(curl --silent --show-error --fail --connect-timeout 10 --max-time 30 \
    --header "@$FAST_HEADER_FILE" "$PLATINUM_URL/v1/auth/orgs/quota")"
  cleanup_fast_header
  trap - EXIT
  unset PLATINUM_KEY
  validate_platinum_atomic_admission "$PLATINUM_QUOTA"
  unset PLATINUM_QUOTA
  echo '▶ verified Platinum atomic template admission for FAST cold boot'
fi
unset SECRET_VALUE
SECRETS_JSON="$(jq -cn --arg arn "$SECRET_ARN" '[{name: "KORTIX_ENV_JSON", valueFrom: $arn}]')"
echo "▶ wired $KEYCOUNT environment values through KORTIX_ENV_JSON from $SECRET_NAME"

# ── base task-def = the service's current one, with runtime fields stripped ──
CURRENT_TD="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
  --services "$SERVICE" --query 'services[0].taskDefinition' --output text)"
[ -n "$CURRENT_TD" ] && [ "$CURRENT_TD" != "None" ] || { echo "service $SERVICE has no task-def" >&2; exit 1; }

CURRENT_TD_JSON="$(aws ecs describe-task-definition --region "$REGION" \
  --task-definition "$CURRENT_TD" --query 'taskDefinition' --output json)"

ENVIRONMENT_OVERRIDES_JSON="${KORTIX_ECS_ENV_OVERRIDES:-}"
[ -n "$ENVIRONMENT_OVERRIDES_JSON" ] || ENVIRONMENT_OVERRIDES_JSON='{}'
if [ "$SVC_KIND" = "api" ]; then
  GATEWAY_TARGET="$(gateway_target_for_env "$ENV")"
  ENVIRONMENT_OVERRIDES_JSON="$(printf '%s' "$ENVIRONMENT_OVERRIDES_JSON" | jq -c \
    --arg target "$GATEWAY_TARGET" '. + {LLM_GATEWAY_PROXY_TARGET: $target}')"
fi
CURRENT_ENVIRONMENT_JSON="$(printf '%s' "$CURRENT_TD_JSON" | jq -c --arg c "$CONTAINER" \
  '[.containerDefinitions[] | select(.name == $c) | (.environment // [])][0] // []')"
MERGED_ENVIRONMENT_JSON="$(merge_environment_overrides "$CURRENT_ENVIRONMENT_JSON" "$ENVIRONMENT_OVERRIDES_JSON")"
ENVIRONMENT_OVERRIDE_COUNT="$(printf '%s' "$ENVIRONMENT_OVERRIDES_JSON" | jq 'length')"
if [ "$ENVIRONMENT_OVERRIDE_COUNT" -gt 0 ]; then
  echo "▶ applied $ENVIRONMENT_OVERRIDE_COUNT explicit non-secret environment override(s)"
fi

# ── task size (cpu/memory) is owned by Terraform, not by the running task ────
# Terraform owns task_cpu/task_memory (infra/terraform/modules/ecs-api), but the
# service carries `ignore_changes = [task_definition]`, so a TF apply that
# resizes the task registers a revision the service never adopts. This renderer
# rebuilds from the service's CURRENT revision — which is how image, env and any
# out-of-band container change survive a deploy — so without the override below
# a Terraform resize could never reach a running task.
#
# Terraform and this script register into the SAME family, and every
# register-task-definition call appends. The family's LATEST ACTIVE revision is
# therefore either (a) Terraform's, immediately after an apply that changed the
# size, or (b) this script's own previous revision, which already carries
# Terraform's size. Taking ONLY cpu/memory from family-latest, and everything
# else from the service's current revision, propagates a Terraform resize on the
# very next deploy and is a no-op on every other deploy. The ordering holds
# because deploy-{dev,staging,prod}.yml run their terraform-* job before the ECS
# roll.
#
# Soft-fail by design: if the family cannot be read, the current size is kept and
# the deploy proceeds exactly as it did before this override existed.
FAMILY="$(printf '%s' "$CURRENT_TD_JSON" | jq -r '.family // empty')"
CURRENT_CPU="$(printf '%s' "$CURRENT_TD_JSON" | jq -r '.cpu // empty')"
CURRENT_MEMORY="$(printf '%s' "$CURRENT_TD_JSON" | jq -r '.memory // empty')"
DESIRED_CPU="$CURRENT_CPU"
DESIRED_MEMORY="$CURRENT_MEMORY"

if [ -n "$FAMILY" ]; then
  LATEST_TD_JSON="$(aws ecs describe-task-definition --region "$REGION" \
    --task-definition "$FAMILY" --query 'taskDefinition' --output json 2>/dev/null || true)"
  if [ -n "$LATEST_TD_JSON" ]; then
    LATEST_CPU="$(printf '%s' "$LATEST_TD_JSON" | jq -r '.cpu // empty')"
    LATEST_MEMORY="$(printf '%s' "$LATEST_TD_JSON" | jq -r '.memory // empty')"
    if [ -n "$LATEST_CPU" ]; then DESIRED_CPU="$LATEST_CPU"; fi
    if [ -n "$LATEST_MEMORY" ]; then DESIRED_MEMORY="$LATEST_MEMORY"; fi
  else
    echo "⚠ could not read family $FAMILY — keeping the running task size ${CURRENT_CPU}/${CURRENT_MEMORY}"
  fi
fi

if [ "$DESIRED_CPU" != "$CURRENT_CPU" ] || [ "$DESIRED_MEMORY" != "$CURRENT_MEMORY" ]; then
  echo "▶ task size ${CURRENT_CPU} cpu / ${CURRENT_MEMORY} MiB → ${DESIRED_CPU} cpu / ${DESIRED_MEMORY} MiB (from the latest $FAMILY revision — Terraform)"
else
  echo "▶ task size ${DESIRED_CPU} cpu / ${DESIRED_MEMORY} MiB (unchanged)"
fi

NEW_TD_JSON="$(printf '%s' "$CURRENT_TD_JSON" \
  | jq --arg img "$IMAGE" --arg c "$CONTAINER" --arg ver "$VERSION_OVERRIDE" \
       --arg version_env "$VERSION_ENV_NAME" \
       --arg cpu "$DESIRED_CPU" --arg memory "$DESIRED_MEMORY" \
       --argjson secrets "$SECRETS_JSON" \
       --argjson environment "$MERGED_ENVIRONMENT_JSON" '
      # drop read-only fields register-task-definition rejects
      del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
          .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
      # Adopt the Terraform task size resolved above. Empty means not readable
      # — keep whatever the running revision declares. NOTE: this jq program is
      # a single-quoted shell string; an apostrophe here terminates it.
      | (if $cpu == "" then . else .cpu = $cpu end)
      | (if $memory == "" then . else .memory = $memory end)
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
                ($environment | map(
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
  echo "$NEW_TD_JSON" | jq '{family, cpu, memory}'
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
