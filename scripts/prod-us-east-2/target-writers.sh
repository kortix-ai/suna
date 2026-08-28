#!/usr/bin/env bash
set -Eeuo pipefail

AWS_REGION="${AWS_REGION:-us-east-2}"
TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix-prod-us-east-2-env}"
TARGET_ECS_CLUSTER="${TARGET_ECS_CLUSTER:-kortix-prod-use2}"
TARGET_ECS_SERVICE="${TARGET_ECS_SERVICE:-kortix-prod-use2}"
TARGET_LOG_GROUP="${TARGET_LOG_GROUP:-/ecs/kortix-prod-use2}"
FREEZE_MARKER_PARAMETER="${FREEZE_MARKER_PARAMETER:-/kortix/prod-use2/source-freeze}"
PRODUCTION_API_URL="${PRODUCTION_API_URL:-https://api.kortix.com}"

APPLICATION_SUBSCRIPTION="kortix_us_east_2_20260725"
AUTH_SUBSCRIPTION="kortix_use2_auth_20260725"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for command_name in aws curl jq; do
  require_command "$command_name"
done

load_target_secret() {
  aws secretsmanager get-secret-value \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$AWS_REGION" \
    --query SecretString \
    --output text
}

current_target_secret_version() {
  aws secretsmanager describe-secret \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$AWS_REGION" \
    --query VersionIdsToStages \
    --output json \
    | jq -er 'to_entries[] | select(.value | index("AWSCURRENT")) | .key'
}

edge_backend() {
  curl -fsS --max-time 15 -D - -o /dev/null "$PRODUCTION_API_URL/v1/health" \
    | awk 'BEGIN { IGNORECASE=1 } /^x-backend:/ {
        gsub("\r", "");
        print $2
      }' \
    | tail -1
}

require_blocking_maintenance() {
  local response_file
  local write_status
  response_file="$(mktemp)"
  write_status="$(
    curl -sS --max-time 15 \
      -o "$response_file" \
      -w '%{http_code}' \
      -X POST \
      -H 'Content-Type: application/json' \
      --data '{}' \
      "$PRODUCTION_API_URL/v1/projects"
  )"
  unlink "$response_file"
  if [[ "$write_status" != "503" ]]; then
    echo "Production edge writes return HTTP $write_status, expected 503." >&2
    exit 1
  fi
}

require_target_backend() {
  local backend
  backend="$(edge_backend)"
  if [[ "$backend" != "us-east-2" ]]; then
    echo "Production edge backend is '${backend:-missing}', expected us-east-2." >&2
    exit 1
  fi
}

require_source_frozen() {
  local marker
  marker="$(
    aws ssm get-parameter \
      --region "$AWS_REGION" \
      --name "$FREEZE_MARKER_PARAMETER" \
      --query Parameter.Value \
      --output text
  )"
  jq -e '.state == "frozen" and (.freezeSecretVersion | length > 0)' \
    <<<"$marker" >/dev/null || {
      echo "The EU source freeze marker is missing or invalid." >&2
      exit 1
    }
}

require_subscriptions_disabled() {
  local secret_json
  local database_url
  local state
  require_command psql
  secret_json="$(load_target_secret)"
  database_url="$(jq -er '.DATABASE_URL' <<<"$secret_json")"
  state="$(
    psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 \
      -v app_subscription="$APPLICATION_SUBSCRIPTION" \
      -v auth_subscription="$AUTH_SUBSCRIPTION" <<'SQL'
SELECT count(*), count(*) FILTER (WHERE NOT subenabled)
FROM pg_subscription
WHERE subname IN (:'app_subscription', :'auth_subscription');
SQL
  )"
  if [[ "$state" != $'2\t2' ]]; then
    echo "Both target subscriptions must exist and be disabled. Current state: $state" >&2
    exit 1
  fi
}

disabled_flags_filter='
  .KORTIX_WORKERS_ENABLED == "false"
  and .SCHEDULER_ENABLED == "false"
  and .CHANNELS_ENABLED == "false"
  and .KORTIX_PRERESUME_ENABLED == "false"
  and .KORTIX_TRIGGER_SCHEDULER_ENABLED == "false"
  and .KORTIX_PROJECT_MAINTENANCE_ENABLED == "false"
  and .KORTIX_LEGACY_MIGRATION_WORKER_ENABLED == "false"
  and .KORTIX_SUNA_MIGRATION_WORKER_ENABLED == "false"
  and .KORTIX_WARM_POOL_ENABLED == "false"
'

enabled_flags_filter='
  .KORTIX_WORKERS_ENABLED == "true"
  and .SCHEDULER_ENABLED == "true"
  and .CHANNELS_ENABLED == "true"
  and .KORTIX_PRERESUME_ENABLED == "true"
  and .KORTIX_TRIGGER_SCHEDULER_ENABLED == "true"
  and .KORTIX_PROJECT_MAINTENANCE_ENABLED == "true"
  and .KORTIX_LEGACY_MIGRATION_WORKER_ENABLED == "false"
  and .KORTIX_SUNA_MIGRATION_WORKER_ENABLED == "false"
  and .KORTIX_WARM_POOL_ENABLED == "false"
'

assert_flags() {
  local expected="$1"
  local secret_json
  secret_json="$(load_target_secret)"
  case "$expected" in
    disabled)
      jq -e "$disabled_flags_filter" <<<"$secret_json" >/dev/null
      ;;
    enabled)
      jq -e "$enabled_flags_filter" <<<"$secret_json" >/dev/null
      ;;
    *)
      echo "Unknown flag state: $expected" >&2
      exit 64
      ;;
  esac
}

write_flags() {
  local mode="$1"
  local secret_json
  local original_version
  local verified_version
  local secret_file

  secret_json="$(load_target_secret)"
  original_version="$(current_target_secret_version)"
  secret_file="$(mktemp)"
  trap 'unlink "$secret_file" 2>/dev/null || true' RETURN

  case "$mode" in
    enabled)
      jq '
        .KORTIX_WORKERS_ENABLED = "true"
        | .SCHEDULER_ENABLED = "true"
        | .CHANNELS_ENABLED = "true"
        | .KORTIX_PRERESUME_ENABLED = "true"
        | .KORTIX_TRIGGER_SCHEDULER_ENABLED = "true"
        | .KORTIX_PROJECT_MAINTENANCE_ENABLED = "true"
        | .KORTIX_LEGACY_MIGRATION_WORKER_ENABLED = "false"
        | .KORTIX_SUNA_MIGRATION_WORKER_ENABLED = "false"
        | .KORTIX_WARM_POOL_ENABLED = "false"
      ' <<<"$secret_json" >"$secret_file"
      ;;
    disabled)
      jq '
        .KORTIX_WORKERS_ENABLED = "false"
        | .SCHEDULER_ENABLED = "false"
        | .CHANNELS_ENABLED = "false"
        | .KORTIX_PRERESUME_ENABLED = "false"
        | .KORTIX_TRIGGER_SCHEDULER_ENABLED = "false"
        | .KORTIX_PROJECT_MAINTENANCE_ENABLED = "false"
        | .KORTIX_LEGACY_MIGRATION_WORKER_ENABLED = "false"
        | .KORTIX_SUNA_MIGRATION_WORKER_ENABLED = "false"
        | .KORTIX_WARM_POOL_ENABLED = "false"
      ' <<<"$secret_json" >"$secret_file"
      ;;
    *)
      echo "Unknown flag mode: $mode" >&2
      exit 64
      ;;
  esac

  verified_version="$(current_target_secret_version)"
  if [[ "$verified_version" != "$original_version" ]]; then
    echo "The target secret changed during preparation. Refusing to overwrite it." >&2
    exit 1
  fi

  aws secretsmanager put-secret-value \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$AWS_REGION" \
    --secret-string "file://$secret_file" \
    --query VersionId \
    --output text
  unlink "$secret_file"
  trap - RETURN
}

restart_target_api() {
  aws ecs update-service \
    --region "$AWS_REGION" \
    --cluster "$TARGET_ECS_CLUSTER" \
    --service "$TARGET_ECS_SERVICE" \
    --force-new-deployment >/dev/null
  aws ecs wait services-stable \
    --region "$AWS_REGION" \
    --cluster "$TARGET_ECS_CLUSTER" \
    --services "$TARGET_ECS_SERVICE"
}

require_worker_leader_log() {
  local start_ms
  local count
  start_ms="$(( $(date -u +%s) * 1000 - 900000 ))"
  for attempt in $(seq 1 30); do
    count="$(
      aws logs filter-log-events \
        --region "$AWS_REGION" \
        --log-group-name "$TARGET_LOG_GROUP" \
        --start-time "$start_ms" \
        --filter-pattern '"acquired background-worker leadership"' \
        --query 'length(events)' \
        --output text
    )"
    if [[ "$count" -ge 1 ]]; then
      echo "US worker leader acquisition is present in CloudWatch."
      return
    fi
    echo "Worker leader verification $attempt/30: no acquisition log yet."
    sleep 5
  done
  echo "No US worker leader acquisition appeared within 150 seconds." >&2
  exit 1
}

enable() {
  local target_flags_changed=false
  rollback_failed_enable() {
    local original_exit="$?"
    trap - ERR
    if [[ "$target_flags_changed" == "true" ]]; then
      echo "US writer activation failed. Restoring disabled flags." >&2
      set +e
      write_flags disabled
      restart_target_api
      assert_flags disabled
      set -e
    fi
    return "$original_exit"
  }
  trap rollback_failed_enable ERR

  if [[ "${ENABLE_TARGET_WRITERS_CONFIRM:-}" != "enable:prod-us-east-2" ]]; then
    echo "Set ENABLE_TARGET_WRITERS_CONFIRM=enable:prod-us-east-2." >&2
    exit 64
  fi
  require_blocking_maintenance
  require_target_backend
  require_source_frozen
  require_subscriptions_disabled
  assert_flags disabled
  write_flags enabled
  target_flags_changed=true
  restart_target_api
  assert_flags enabled
  require_worker_leader_log
  trap - ERR
  echo "US workers and schedulers are enabled. Legacy migration workers remain disabled."
}

disable() {
  if [[ "${DISABLE_TARGET_WRITERS_CONFIRM:-}" != "disable:prod-us-east-2" ]]; then
    echo "Set DISABLE_TARGET_WRITERS_CONFIRM=disable:prod-us-east-2." >&2
    exit 64
  fi
  require_blocking_maintenance
  write_flags disabled
  restart_target_api
  assert_flags disabled
  echo "US workers and schedulers are disabled."
}

status() {
  local secret_json
  secret_json="$(load_target_secret)"
  jq '{
    KORTIX_WORKERS_ENABLED,
    SCHEDULER_ENABLED,
    CHANNELS_ENABLED,
    KORTIX_PRERESUME_ENABLED,
    KORTIX_TRIGGER_SCHEDULER_ENABLED,
    KORTIX_PROJECT_MAINTENANCE_ENABLED,
    KORTIX_LEGACY_MIGRATION_WORKER_ENABLED,
    KORTIX_SUNA_MIGRATION_WORKER_ENABLED,
    KORTIX_WARM_POOL_ENABLED
  }' <<<"$secret_json"
  aws ecs describe-services \
    --region "$AWS_REGION" \
    --cluster "$TARGET_ECS_CLUSTER" \
    --services "$TARGET_ECS_SERVICE" \
    --query 'services[0].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition,rollout:deployments[0].rolloutState}' \
    --output json
  echo "api.kortix.com backend: $(edge_backend)"
}

case "${1:-}" in
  enable)
    enable
    ;;
  disable)
    disable
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 {enable|disable|status}" >&2
    exit 64
    ;;
esac
