#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_AWS_REGION="${SOURCE_AWS_REGION:-eu-west-2}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-east-2}"
SOURCE_SECRET_ID="${SOURCE_SECRET_ID:-kortix-prod-env}"
TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix-prod-us-east-2-env}"
SOURCE_EKS_CLUSTER="${SOURCE_EKS_CLUSTER:-kortix-prod-eks}"
SOURCE_EKS_NAMESPACE="${SOURCE_EKS_NAMESPACE:-kortix-prod}"
STATE_DIRECTORY="${STATE_DIRECTORY:-.cutover-state}"
STATE_FILE="${STATE_FILE:-$STATE_DIRECTORY/prod-use2-source-writers.json}"
KUBECONFIG_FILE="${KUBECONFIG_FILE:-$STATE_DIRECTORY/prod-use2-kubeconfig}"
FREEZE_MARKER_PARAMETER="${FREEZE_MARKER_PARAMETER:-/kortix/prod-use2/source-freeze}"

SOURCE_ECS_RESOURCES=(
  "kortix-prod|kortix-prod"
  "kortix-prod-gateway|kortix-prod-gateway"
)
SOURCE_EKS_DEPLOYMENTS=("kortix-api" "kortix-gateway")
SOURCE_ARGO_APPLICATIONS=("kortix-prod" "kortix-gateway-prod")

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for command_name in aws curl jq kubectl psql; do
  require_command "$command_name"
done

umask 077
mkdir -p "$STATE_DIRECTORY"

load_source_secret() {
  aws secretsmanager get-secret-value \
    --secret-id "$SOURCE_SECRET_ID" \
    --region "$SOURCE_AWS_REGION" \
    --query SecretString \
    --output text
}

load_target_secret() {
  aws secretsmanager get-secret-value \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$TARGET_AWS_REGION" \
    --query SecretString \
    --output text
}

current_source_secret_version() {
  aws secretsmanager describe-secret \
    --secret-id "$SOURCE_SECRET_ID" \
    --region "$SOURCE_AWS_REGION" \
    --query VersionIdsToStages \
    --output json \
    | jq -er 'to_entries[] | select(.value | index("AWSCURRENT")) | .key'
}

prepare_kubeconfig() {
  aws eks update-kubeconfig \
    --name "$SOURCE_EKS_CLUSTER" \
    --region "$SOURCE_AWS_REGION" \
    --kubeconfig "$KUBECONFIG_FILE" >/dev/null
  export KUBECONFIG="$KUBECONFIG_FILE"
}

edge_backend() {
  curl -fsS --max-time 15 -D - -o /dev/null https://api.kortix.com/v1/health \
    | awk 'BEGIN { IGNORECASE=1 } /^x-backend:/ {
        gsub("\r", "");
        print $2
      }' \
    | tail -1
}

require_blocking_maintenance() {
  local write_status
  write_status="$(
    curl -sS --max-time 15 \
      -o "$STATE_DIRECTORY/maintenance-write-response" \
      -w '%{http_code}' \
      -X POST \
      -H 'Content-Type: application/json' \
      --data '{}' \
      https://api.kortix.com/v1/projects
  )"
  if [[ "$write_status" != "503" ]]; then
    echo "Production edge writes return HTTP $write_status, expected 503." >&2
    exit 1
  fi
}

target_subscription_state() {
  local target_secret_json
  local target_database_url
  target_secret_json="$(load_target_secret)"
  target_database_url="$(jq -er '.DATABASE_URL' <<<"$target_secret_json")"
  psql "$target_database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 <<'SQL'
SELECT subname, subenabled
FROM pg_subscription
WHERE subname IN (
  'kortix_us_east_2_20260725',
  'kortix_use2_auth_20260725'
)
ORDER BY subname;
SQL
}

write_state() {
  local payload="$1"
  local temporary_file="$STATE_FILE.tmp"
  printf '%s\n' "$payload" >"$temporary_file"
  mv "$temporary_file" "$STATE_FILE"
}

update_state() {
  local temporary_file="$STATE_FILE.tmp"
  jq "$@" "$STATE_FILE" >"$temporary_file"
  mv "$temporary_file" "$STATE_FILE"
}

capture_state() {
  local source_secret_version
  local ecs_services='[]'
  local autoscaling_targets
  local eks_deployments
  local hpas
  local argo_applications
  local cron_exists
  local cluster
  local service
  local service_json
  local source_secret_json
  local source_database_url
  local payload
  local phase

  if [[ -f "$STATE_FILE" ]]; then
    phase="$(jq -er '.phase' "$STATE_FILE")"
    if [[ "$phase" == "prepared" || "$phase" == "frozen" ]]; then
      return
    fi
    if [[ "$phase" == "restored" ]]; then
      mv "$STATE_FILE" "$STATE_FILE.restored.$(date -u +%s)"
    else
      echo "Unknown source-writer state phase: $phase" >&2
      exit 1
    fi
  fi

  prepare_kubeconfig
  source_secret_version="$(current_source_secret_version)"

  for coordinate in "${SOURCE_ECS_RESOURCES[@]}"; do
    IFS='|' read -r cluster service <<<"$coordinate"
    service_json="$(
      aws ecs describe-services \
        --region "$SOURCE_AWS_REGION" \
        --cluster "$cluster" \
        --services "$service" \
        --query 'services[0].{cluster:clusterArn,service:serviceName,desiredCount:desiredCount}' \
        --output json
    )"
    ecs_services="$(jq -c --argjson item "$service_json" '. + [$item]' <<<"$ecs_services")"
  done

  autoscaling_targets="$(
    aws application-autoscaling describe-scalable-targets \
      --region "$SOURCE_AWS_REGION" \
      --service-namespace ecs \
      --resource-ids \
        service/kortix-prod/kortix-prod \
        service/kortix-prod-gateway/kortix-prod-gateway \
      --scalable-dimension ecs:service:DesiredCount \
      --output json \
      | jq -c '[.ScalableTargets[] | {
          resourceId: .ResourceId,
          minCapacity: .MinCapacity,
          maxCapacity: .MaxCapacity,
          suspendedState: .SuspendedState
        }]'
  )"

  eks_deployments="$(
    kubectl -n "$SOURCE_EKS_NAMESPACE" get deployment \
      "${SOURCE_EKS_DEPLOYMENTS[@]}" -o json \
      | jq -c '[.items[] | {
          name: .metadata.name,
          replicas: (.spec.replicas // 1)
        }]'
  )"
  hpas="$(
    kubectl -n "$SOURCE_EKS_NAMESPACE" get hpa \
      "${SOURCE_EKS_DEPLOYMENTS[@]}" -o json \
      | jq -c '{
          apiVersion,
          kind,
          metadata: {},
          items: [.items[] |
            del(
              .metadata.creationTimestamp,
              .metadata.generation,
              .metadata.managedFields,
              .metadata.resourceVersion,
              .metadata.uid,
              .status
            )
          ]
        }'
  )"
  argo_applications="$(
    kubectl -n argocd get application \
      "${SOURCE_ARGO_APPLICATIONS[@]}" -o json \
      | jq -c '[.items[] | {
          name: .metadata.name,
          syncPolicy: .spec.syncPolicy
        }]'
  )"

  source_secret_json="$(load_source_secret)"
  source_database_url="$(jq -er '.DATABASE_URL' <<<"$source_secret_json")"
  cron_exists="$(
    psql "$source_database_url" -X -qAt -v ON_ERROR_STOP=1 \
      -c "SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kortix_global_tick')"
  )"
  if [[ "$cron_exists" == "t" ]]; then
    cron_exists=true
  else
    cron_exists=false
  fi

  payload="$(
    jq -nc \
      --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --arg phase "prepared" \
      --arg sourceSecretVersion "$source_secret_version" \
      --argjson ecsServices "$ecs_services" \
      --argjson autoscalingTargets "$autoscaling_targets" \
      --argjson eksDeployments "$eks_deployments" \
      --argjson hpas "$hpas" \
      --argjson argoApplications "$argo_applications" \
      --argjson cronExisted "$cron_exists" \
      '{
        capturedAt: $capturedAt,
        phase: $phase,
        sourceSecretVersion: $sourceSecretVersion,
        freezeSecretVersion: null,
        ecsServices: $ecsServices,
        autoscalingTargets: $autoscalingTargets,
        eksDeployments: $eksDeployments,
        hpas: $hpas,
        argoApplications: $argoApplications,
        cronExisted: $cronExisted
      }'
  )"
  write_state "$payload"
}

freeze_secret_flags() {
  local source_secret_json
  local current_version
  local previous_version
  local freeze_version
  local secret_file="$STATE_DIRECTORY/frozen-source-secret.json"

  source_secret_json="$(load_source_secret)"
  current_version="$(current_source_secret_version)"
  previous_version="$(jq -er '.sourceSecretVersion' "$STATE_FILE")"

  if jq -e '
    .KORTIX_WORKERS_ENABLED == "false"
    and .SCHEDULER_ENABLED == "false"
    and .CHANNELS_ENABLED == "false"
    and .KORTIX_PRERESUME_ENABLED == "false"
    and .KORTIX_TRIGGER_SCHEDULER_ENABLED == "false"
    and .KORTIX_PROJECT_MAINTENANCE_ENABLED == "false"
    and .KORTIX_LEGACY_MIGRATION_WORKER_ENABLED == "false"
    and .KORTIX_SUNA_MIGRATION_WORKER_ENABLED == "false"
    and .KORTIX_WARM_POOL_ENABLED == "false"
    and .KORTIX_WARM_SNAPSHOT_ENABLED == "false"
  ' <<<"$source_secret_json" >/dev/null; then
    # shellcheck disable=SC2016 # $version is a jq variable.
    update_state --arg version "$current_version" '.freezeSecretVersion = $version'
    return
  fi

  if [[ "$current_version" != "$previous_version" ]]; then
    echo "The source secret changed after state capture. Refusing to overwrite it." >&2
    exit 1
  fi

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
    | .KORTIX_WARM_SNAPSHOT_ENABLED = "false"
  ' <<<"$source_secret_json" >"$secret_file"

  freeze_version="$(
    aws secretsmanager put-secret-value \
      --secret-id "$SOURCE_SECRET_ID" \
      --region "$SOURCE_AWS_REGION" \
      --secret-string "file://$secret_file" \
      --query VersionId \
      --output text
  )"
  unlink "$secret_file"
  # shellcheck disable=SC2016 # $version is a jq variable.
  update_state --arg version "$freeze_version" '.freezeSecretVersion = $version'
}

suspend_argo() {
  local application
  for application in "${SOURCE_ARGO_APPLICATIONS[@]}"; do
    if kubectl -n argocd get application "$application" -o json \
      | jq -e '.spec.syncPolicy.automated != null' >/dev/null; then
      kubectl -n argocd patch application "$application" --type json \
        -p '[{"op":"remove","path":"/spec/syncPolicy/automated"}]' >/dev/null
    fi
  done
}

freeze_ecs() {
  local cluster
  local service
  local resource_id
  local target

  for resource_id in \
    service/kortix-prod/kortix-prod \
    service/kortix-prod-gateway/kortix-prod-gateway; do
    target="$(
      jq -cer --arg id "$resource_id" \
        '.autoscalingTargets[] | select(.resourceId == $id)' "$STATE_FILE"
    )"
    aws application-autoscaling register-scalable-target \
      --region "$SOURCE_AWS_REGION" \
      --service-namespace ecs \
      --resource-id "$resource_id" \
      --scalable-dimension ecs:service:DesiredCount \
      --min-capacity "$(jq -r '.minCapacity' <<<"$target")" \
      --max-capacity "$(jq -r '.maxCapacity' <<<"$target")" \
      --suspended-state \
        DynamicScalingInSuspended=true,DynamicScalingOutSuspended=true,ScheduledScalingSuspended=true \
      >/dev/null
  done

  for coordinate in "${SOURCE_ECS_RESOURCES[@]}"; do
    IFS='|' read -r cluster service <<<"$coordinate"
    aws ecs update-service \
      --region "$SOURCE_AWS_REGION" \
      --cluster "$cluster" \
      --service "$service" \
      --desired-count 0 >/dev/null
  done
}

freeze_eks() {
  kubectl -n "$SOURCE_EKS_NAMESPACE" delete hpa \
    "${SOURCE_EKS_DEPLOYMENTS[@]}" --ignore-not-found >/dev/null
  kubectl -n "$SOURCE_EKS_NAMESPACE" scale deployment \
    "${SOURCE_EKS_DEPLOYMENTS[@]}" --replicas=0 >/dev/null
}

wait_for_zero_writers() {
  local cluster
  local service
  local running
  local ready
  local application
  local count

  for attempt in $(seq 1 120); do
    running=0
    for coordinate in "${SOURCE_ECS_RESOURCES[@]}"; do
      IFS='|' read -r cluster service <<<"$coordinate"
      count="$(
        aws ecs describe-services \
          --region "$SOURCE_AWS_REGION" \
          --cluster "$cluster" \
          --services "$service" \
          --query 'services[0].runningCount' \
          --output text
      )"
      running=$((running + count))
    done
    ready="$(
      kubectl -n "$SOURCE_EKS_NAMESPACE" get deployment \
        "${SOURCE_EKS_DEPLOYMENTS[@]}" -o json \
        | jq '[.items[].status.readyReplicas // 0] | add'
    )"
    if [[ "$running" == "0" && "$ready" == "0" ]]; then
      echo "EU ECS and EKS application tasks are stopped."
      return
    fi
    echo "Source stop $attempt/120: ECS running=$running EKS ready=$ready"
    sleep 5
  done

  echo "Source application tasks did not stop within ten minutes." >&2
  exit 1
}

unschedule_source_cron() {
  local source_secret_json
  local source_database_url
  source_secret_json="$(load_source_secret)"
  source_database_url="$(jq -er '.DATABASE_URL' <<<"$source_secret_json")"
  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 <<'SQL'
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'kortix_global_tick';
SQL
}

assert_source_frozen() {
  local source_secret_json
  local source_database_url
  local cron_count
  local cluster
  local service
  local desired
  local running
  local ready

  source_secret_json="$(load_source_secret)"
  jq -e '
    .KORTIX_WORKERS_ENABLED == "false"
    and .KORTIX_TRIGGER_SCHEDULER_ENABLED == "false"
    and .KORTIX_PROJECT_MAINTENANCE_ENABLED == "false"
    and .KORTIX_LEGACY_MIGRATION_WORKER_ENABLED == "false"
    and .KORTIX_SUNA_MIGRATION_WORKER_ENABLED == "false"
  ' <<<"$source_secret_json" >/dev/null

  for coordinate in "${SOURCE_ECS_RESOURCES[@]}"; do
    IFS='|' read -r cluster service <<<"$coordinate"
    IFS=$'\t' read -r desired running < <(
      aws ecs describe-services \
        --region "$SOURCE_AWS_REGION" \
        --cluster "$cluster" \
        --services "$service" \
        --query 'services[0].[desiredCount,runningCount]' \
        --output text
    )
    [[ "$desired" == "0" && "$running" == "0" ]] || {
      echo "$service is desired=$desired running=$running, expected 0/0." >&2
      exit 1
    }
  done

  prepare_kubeconfig
  ready="$(
    kubectl -n "$SOURCE_EKS_NAMESPACE" get deployment \
      "${SOURCE_EKS_DEPLOYMENTS[@]}" -o json \
      | jq '[.items[] | (.spec.replicas // 0) + (.status.readyReplicas // 0)] | add'
  )"
  [[ "$ready" == "0" ]] || {
    echo "EU EKS still has desired or ready application pods." >&2
    exit 1
  }
  if kubectl -n "$SOURCE_EKS_NAMESPACE" get hpa \
    "${SOURCE_EKS_DEPLOYMENTS[@]}" --ignore-not-found -o name \
    | grep -q .; then
    echo "EU EKS application autoscalers remain active." >&2
    exit 1
  fi
  for application in "${SOURCE_ARGO_APPLICATIONS[@]}"; do
    if kubectl -n argocd get application "$application" -o json \
      | jq -e '.spec.syncPolicy.automated != null' >/dev/null; then
      echo "$application automated sync remains active." >&2
      exit 1
    fi
  done

  source_database_url="$(jq -er '.DATABASE_URL' <<<"$source_secret_json")"
  cron_count="$(
    psql "$source_database_url" -X -qAt -v ON_ERROR_STOP=1 \
      -c "SELECT count(*) FROM cron.job WHERE jobname = 'kortix_global_tick'"
  )"
  [[ "$cron_count" == "0" ]] || {
    echo "kortix_global_tick remains scheduled on the source." >&2
    exit 1
  }
  echo "Source writers are frozen."
}

publish_freeze_marker() {
  local marker
  marker="$(
    jq -c '{
      state: "frozen",
      capturedAt,
      sourceSecretVersion,
      freezeSecretVersion
    }' "$STATE_FILE"
  )"
  aws ssm put-parameter \
    --region "$TARGET_AWS_REGION" \
    --name "$FREEZE_MARKER_PARAMETER" \
    --type String \
    --overwrite \
    --value "$marker" >/dev/null
}

remove_freeze_marker() {
  aws ssm delete-parameter \
    --region "$TARGET_AWS_REGION" \
    --name "$FREEZE_MARKER_PARAMETER" >/dev/null 2>&1 || true
}

restore_source_secret() {
  local previous_version
  local freeze_version
  local current_version

  previous_version="$(jq -er '.sourceSecretVersion' "$STATE_FILE")"
  freeze_version="$(jq -er '.freezeSecretVersion' "$STATE_FILE")"
  current_version="$(current_source_secret_version)"
  if [[ "$current_version" == "$previous_version" ]]; then
    return
  fi
  if [[ "$current_version" != "$freeze_version" ]]; then
    echo "The source secret changed after the freeze. Refusing to restore an older version." >&2
    exit 1
  fi

  aws secretsmanager update-secret-version-stage \
    --secret-id "$SOURCE_SECRET_ID" \
    --region "$SOURCE_AWS_REGION" \
    --version-stage AWSCURRENT \
    --move-to-version-id "$previous_version" \
    --remove-from-version-id "$freeze_version" >/dev/null
}

restore_ecs() {
  local resource_id
  local cluster
  local service

  while IFS= read -r target; do
    resource_id="$(jq -r '.resourceId' <<<"$target")"
    aws application-autoscaling register-scalable-target \
      --region "$SOURCE_AWS_REGION" \
      --service-namespace ecs \
      --resource-id "$resource_id" \
      --scalable-dimension ecs:service:DesiredCount \
      --min-capacity "$(jq -r '.minCapacity' <<<"$target")" \
      --max-capacity "$(jq -r '.maxCapacity' <<<"$target")" \
      --suspended-state "$(
        jq -r '
          .suspendedState |
          "DynamicScalingInSuspended=\(.DynamicScalingInSuspended)," +
          "DynamicScalingOutSuspended=\(.DynamicScalingOutSuspended)," +
          "ScheduledScalingSuspended=\(.ScheduledScalingSuspended)"
        ' <<<"$target"
      )" >/dev/null
  done < <(jq -c '.autoscalingTargets[]' "$STATE_FILE")

  while IFS= read -r service_state; do
    cluster="$(jq -r '.cluster | split("/")[-1]' <<<"$service_state")"
    service="$(jq -r '.service' <<<"$service_state")"
    aws ecs update-service \
      --region "$SOURCE_AWS_REGION" \
      --cluster "$cluster" \
      --service "$service" \
      --desired-count "$(jq -r '.desiredCount' <<<"$service_state")" \
      --force-new-deployment >/dev/null
  done < <(jq -c '.ecsServices[]' "$STATE_FILE")
}

restore_eks_and_argo() {
  local hpa_file="$STATE_DIRECTORY/source-hpas.json"
  local name
  local replicas
  local patch

  jq '.hpas' "$STATE_FILE" >"$hpa_file"
  kubectl apply -f "$hpa_file" >/dev/null
  unlink "$hpa_file"

  while IFS=$'\t' read -r name replicas; do
    kubectl -n "$SOURCE_EKS_NAMESPACE" scale deployment "$name" \
      --replicas="$replicas" >/dev/null
    kubectl -n "$SOURCE_EKS_NAMESPACE" rollout restart deployment "$name" >/dev/null
  done < <(jq -r '.eksDeployments[] | [.name, (.replicas | tostring)] | @tsv' "$STATE_FILE")

  while IFS= read -r application; do
    name="$(jq -r '.name' <<<"$application")"
    patch="$(jq -c '{spec:{syncPolicy:.syncPolicy}}' <<<"$application")"
    kubectl -n argocd patch application "$name" --type merge -p "$patch" >/dev/null
  done < <(jq -c '.argoApplications[]' "$STATE_FILE")
}

wait_for_restored_writers() {
  local cluster
  local service
  local expected
  local running
  local desired
  local ready
  local expected_eks
  local all_ready

  for attempt in $(seq 1 120); do
    all_ready=true
    while IFS= read -r service_state; do
      cluster="$(jq -r '.cluster | split("/")[-1]' <<<"$service_state")"
      service="$(jq -r '.service' <<<"$service_state")"
      expected="$(jq -r '.desiredCount' <<<"$service_state")"
      IFS=$'\t' read -r desired running < <(
        aws ecs describe-services \
          --region "$SOURCE_AWS_REGION" \
          --cluster "$cluster" \
          --services "$service" \
          --query 'services[0].[desiredCount,runningCount]' \
          --output text
      )
      if [[ "$desired" -lt "$expected" || "$running" -lt "$expected" ]]; then
        all_ready=false
      fi
    done < <(jq -c '.ecsServices[]' "$STATE_FILE")
    ready="$(
      kubectl -n "$SOURCE_EKS_NAMESPACE" get deployment \
        "${SOURCE_EKS_DEPLOYMENTS[@]}" -o json \
        | jq '[.items[] | (.status.readyReplicas // 0)] | add'
    )"
    expected_eks="$(jq '[.eksDeployments[].replicas] | add' "$STATE_FILE")"
    if [[ "$all_ready" == "true" && "$ready" -ge "$expected_eks" ]]; then
      echo "EU ECS and EKS application tasks are restored."
      return
    fi
    echo "Source restore $attempt/120: ECS ready=$all_ready EKS ready=$ready/$expected_eks"
    sleep 5
  done

  echo "Source application tasks did not restore within ten minutes." >&2
  exit 1
}

restore_source_cron() {
  local source_secret_json
  local source_database_url
  local cron_api_url
  local cron_tick_secret

  if [[ "$(jq -r '.cronExisted' "$STATE_FILE")" != "true" ]]; then
    return
  fi
  source_secret_json="$(load_source_secret)"
  source_database_url="$(jq -er '.DATABASE_URL' <<<"$source_secret_json")"
  cron_api_url="$(jq -er '.CRON_API_URL' <<<"$source_secret_json")"
  cron_tick_secret="$(jq -er '.CRON_TICK_SECRET' <<<"$source_secret_json")"
  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v api_url="$cron_api_url" \
    -v tick_secret="$cron_tick_secret" <<'SQL'
SELECT kortix.configure_scheduler(:'api_url', :'tick_secret');
SQL
}

freeze() {
  if [[ "${FREEZE_SOURCE_WRITERS_CONFIRM:-}" != "freeze:prod-eu-west-2" ]]; then
    echo "Set FREEZE_SOURCE_WRITERS_CONFIRM=freeze:prod-eu-west-2." >&2
    exit 64
  fi
  require_blocking_maintenance
  if [[ "$(edge_backend)" != "ecs-fargate" ]]; then
    echo "api.kortix.com does not point to the EU ECS source." >&2
    exit 1
  fi

  capture_state
  prepare_kubeconfig
  freeze_secret_flags
  suspend_argo
  freeze_eks
  freeze_ecs
  wait_for_zero_writers
  unschedule_source_cron
  update_state '.phase = "frozen"'
  assert_source_frozen
  publish_freeze_marker
}

unfreeze() {
  local target_secret_json
  local subscriptions

  if [[ "${UNFREEZE_SOURCE_WRITERS_CONFIRM:-}" != "unfreeze:prod-eu-west-2" ]]; then
    echo "Set UNFREEZE_SOURCE_WRITERS_CONFIRM=unfreeze:prod-eu-west-2." >&2
    exit 64
  fi
  [[ -f "$STATE_FILE" ]] || {
    echo "Missing freeze state: $STATE_FILE" >&2
    exit 1
  }
  require_blocking_maintenance

  target_secret_json="$(load_target_secret)"
  jq -e '
    .KORTIX_WORKERS_ENABLED == "false"
    and .KORTIX_TRIGGER_SCHEDULER_ENABLED == "false"
    and .KORTIX_PROJECT_MAINTENANCE_ENABLED == "false"
    and .KORTIX_LEGACY_MIGRATION_WORKER_ENABLED == "false"
    and .KORTIX_SUNA_MIGRATION_WORKER_ENABLED == "false"
  ' <<<"$target_secret_json" >/dev/null || {
    echo "US writers are enabled. Refusing to reopen the EU source." >&2
    exit 1
  }

  subscriptions="$(target_subscription_state)"
  if [[ "$(awk '$2 != "t" { count++ } END { print count + 0 }' <<<"$subscriptions")" != "0" ]] \
    || [[ "$(wc -l <<<"$subscriptions" | tr -d ' ')" != "2" ]]; then
    echo "Both target subscriptions must be enabled before EU rollback." >&2
    printf '%s\n' "$subscriptions" >&2
    exit 1
  fi

  prepare_kubeconfig
  restore_source_secret
  restore_ecs
  restore_eks_and_argo
  wait_for_restored_writers
  restore_source_cron
  update_state '.phase = "restored"'
  remove_freeze_marker
  echo "EU source writers are restored under blocking maintenance."
}

status() {
  local source_secret_json
  local source_database_url
  local cluster
  local service

  source_secret_json="$(load_source_secret)"
  jq '{
    KORTIX_WORKERS_ENABLED,
    SCHEDULER_ENABLED,
    CHANNELS_ENABLED,
    KORTIX_PRERESUME_ENABLED,
    KORTIX_TRIGGER_SCHEDULER_ENABLED,
    KORTIX_PROJECT_MAINTENANCE_ENABLED,
    KORTIX_LEGACY_MIGRATION_WORKER_ENABLED,
    KORTIX_SUNA_MIGRATION_WORKER_ENABLED,
    KORTIX_WARM_POOL_ENABLED,
    KORTIX_WARM_SNAPSHOT_ENABLED
  }' <<<"$source_secret_json"

  for coordinate in "${SOURCE_ECS_RESOURCES[@]}"; do
    IFS='|' read -r cluster service <<<"$coordinate"
    aws ecs describe-services \
      --region "$SOURCE_AWS_REGION" \
      --cluster "$cluster" \
      --services "$service" \
      --query 'services[0].{service:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition}' \
      --output json
  done

  prepare_kubeconfig
  kubectl -n "$SOURCE_EKS_NAMESPACE" get deployment,hpa -o wide
  source_database_url="$(jq -er '.DATABASE_URL' <<<"$source_secret_json")"
  psql "$source_database_url" -X -P pager=off -v ON_ERROR_STOP=1 <<'SQL'
SELECT jobid, jobname, schedule, active
FROM cron.job
WHERE jobname = 'kortix_global_tick';
SQL
  echo "api.kortix.com backend: $(edge_backend)"
  [[ -f "$STATE_FILE" ]] && jq '{capturedAt,phase}' "$STATE_FILE"
}

case "${1:-}" in
  status)
    status
    ;;
  freeze)
    freeze
    ;;
  assert-frozen)
    assert_source_frozen
    ;;
  unfreeze)
    unfreeze
    ;;
  *)
    echo "Usage: scripts/prod-us-east-2/source-writers.sh {status|freeze|assert-frozen|unfreeze}" >&2
    exit 64
    ;;
esac
