#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:?usage: ecs-preview.sh deploy|teardown|reconcile <pr-number|0> [api-image] [gateway-image] [web-image] [commit]}"
PR="${2:?PR number required}"

if { [ "$ACTION" = "reconcile" ] && [ "$PR" != "0" ]; } \
  || { [ "$ACTION" != "reconcile" ] && { ! [[ "$PR" =~ ^[1-9][0-9]*$ ]] || [ "$PR" -gt 20000 ]; }; }; then
  echo "invalid PR number: $PR" >&2
  exit 2
fi

REGION="${AWS_REGION:-us-west-2}"
CLUSTER="kortix-preview"
SERVICE="kortix-pr-${PR}"
FAMILY="$SERVICE"
API_TARGET_GROUP_NAME="kortix-pr-${PR}"
WEB_TARGET_GROUP_NAME="kortix-pr-${PR}-web"
HOST="pr-${PR}.preview-api.kortix.com"
WEB_HOST="pr-${PR}.preview.kortix.com"
SECRET_NAME="kortix-preview-env"
WEB_SECRET_NAME="kortix-dev-web-env"
EXECUTION_ROLE="arn:aws:iam::935064898258:role/kortix-preview-exec"
TASK_ROLE="arn:aws:iam::935064898258:role/kortix-preview-task"
LOG_GROUP="/ecs/kortix-preview"
MAX_ACTIVE_PREVIEWS="${MAX_ACTIVE_PREVIEWS:-20}"
SERVICE_WAS_ACTIVE=false
PREVIOUS_TASK_DEFINITION=""
TASK_DEFINITION=""
TASK_FILE=""

aws_text() {
  local value
  value="$("$@")"
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    return 1
  fi
  printf '%s\n' "$value"
}

require_runtime() {
  aws ecs describe-clusters --region "$REGION" --clusters "$CLUSTER" \
    --query 'clusters[0].status' --output text | grep -qx ACTIVE || {
      echo "preview runtime is not bootstrapped: ECS cluster $CLUSTER is unavailable" >&2
      exit 1
    }
}

listener_arn() {
  local alb
  alb="$(aws_text aws elbv2 describe-load-balancers --region "$REGION" --names kortix-preview-alb \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
  # shellcheck disable=SC2016 # Backticks are AWS CLI JMESPath number literals.
  aws_text aws elbv2 describe-listeners --region "$REGION" --load-balancer-arn "$alb" \
    --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text
}

find_rule() {
  local listener="$1"
  local host="$2"
  aws elbv2 describe-rules --region "$REGION" --listener-arn "$listener" \
    --output json 2>/dev/null \
    | jq -r --arg host "$host" \
      '[.Rules[] | select(any(.Conditions[]?; .Field == "host-header" and any(.Values[]?; . == $host))) | .RuleArn][0] // empty' \
    || true
}

find_target_group() {
  aws elbv2 describe-target-groups --region "$REGION" --names "$1" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true
}

teardown() {
  local listener rule target_group task_definitions host target_group_name
  if ! aws ecs describe-clusters --region "$REGION" --clusters "$CLUSTER" \
    --query 'clusters[0].status' --output text 2>/dev/null | grep -qx ACTIVE; then
    echo "preview runtime is absent; preview $PR is already torn down"
    return
  fi
  listener="$(listener_arn 2>/dev/null || true)"
  if [ -n "$listener" ]; then
    for host in "$HOST" "$WEB_HOST"; do
      rule="$(find_rule "$listener" "$host")"
      if [ -n "$rule" ] && [ "$rule" != "None" ]; then
        aws elbv2 delete-rule --region "$REGION" --rule-arn "$rule"
      fi
    done
  fi

  if aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].status' --output text 2>/dev/null | grep -qx ACTIVE; then
    aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
      --desired-count 0 >/dev/null
    aws ecs delete-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
      --force >/dev/null
    for _ in $(seq 1 60); do
      status="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
        --query 'services[0].status' --output text 2>/dev/null || true)"
      [ -z "$status" ] || [ "$status" = "None" ] || [ "$status" = "INACTIVE" ] && break
      sleep 5
    done
    [ -z "$status" ] || [ "$status" = "None" ] || [ "$status" = "INACTIVE" ] || {
      echo "ECS service $SERVICE did not become inactive" >&2
      exit 1
    }
  fi

  for target_group_name in "$API_TARGET_GROUP_NAME" "$WEB_TARGET_GROUP_NAME"; do
    target_group="$(find_target_group "$target_group_name")"
    if [ -n "$target_group" ] && [ "$target_group" != "None" ]; then
      deleted=false
      for _ in $(seq 1 30); do
        if aws elbv2 delete-target-group --region "$REGION" --target-group-arn "$target_group" 2>/dev/null; then
          deleted=true
          break
        fi
        sleep 5
      done
      [ "$deleted" = true ] || { echo "target group $target_group remained attached" >&2; exit 1; }
    fi
  done

  task_definitions="$(aws ecs list-task-definitions --region "$REGION" --family-prefix "$FAMILY" \
    --status ACTIVE --query 'taskDefinitionArns[]' --output text)"
  for task_definition in $task_definitions; do
    aws ecs deregister-task-definition --region "$REGION" --task-definition "$task_definition" >/dev/null
  done
  echo "preview $PR torn down"
}

reconcile() {
  local cutoff service_arn service_name created_at pr_number state labels
  cutoff="$(date -u -d "${PREVIEW_MAX_AGE_HOURS:-72} hours ago" +%s)"
  for service_arn in $(aws ecs list-services --region "$REGION" --cluster "$CLUSTER" \
    --query 'serviceArns[]' --output text); do
    service_name="${service_arn##*/}"
    [[ "$service_name" =~ ^kortix-pr-([1-9][0-9]*)$ ]] || continue
    pr_number="${BASH_REMATCH[1]}"
    created_at="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$service_name" \
      --query 'services[0].createdAt' --output text)"
    [ "$(date -u -d "$created_at" +%s)" -lt "$cutoff" ] || continue
    if ! state="$(gh api "repos/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}/pulls/${pr_number}" \
      --jq '.state')"; then
      echo "could not read PR $pr_number; preserving its preview" >&2
      continue
    fi
    if ! labels="$(gh api "repos/${GITHUB_REPOSITORY}/issues/${pr_number}/labels" \
      --jq 'map(.name) | join(" ")')"; then
      echo "could not read labels for PR $pr_number; preserving its preview" >&2
      continue
    fi
    if [ "$state" != "open" ] || [[ " $labels " != *" preview "* ]]; then
      "$0" teardown "$pr_number"
    fi
  done
}

rollback_deploy() {
  local exit_code=$?
  trap - EXIT
  rm -f "$TASK_FILE"
  if [ "$exit_code" -ne 0 ]; then
    if [ "$SERVICE_WAS_ACTIVE" = true ] && [ -n "$PREVIOUS_TASK_DEFINITION" ]; then
      echo "preview $PR update failed; restoring $PREVIOUS_TASK_DEFINITION" >&2
      aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
        --task-definition "$PREVIOUS_TASK_DEFINITION" --desired-count 1 --force-new-deployment >/dev/null \
        || echo "preview $PR service rollback also failed" >&2
      if [ -n "$TASK_DEFINITION" ] && [ "$TASK_DEFINITION" != "$PREVIOUS_TASK_DEFINITION" ]; then
        aws ecs deregister-task-definition --region "$REGION" --task-definition "$TASK_DEFINITION" >/dev/null \
          || echo "preview $PR task-definition rollback also failed" >&2
      fi
    else
      echo "preview $PR deploy failed; removing partial per-PR resources" >&2
      teardown || echo "preview $PR rollback teardown also failed" >&2
    fi
  fi
  exit "$exit_code"
}

if [ "$ACTION" = "teardown" ]; then
  teardown
  exit 0
fi

if [ "$ACTION" = "reconcile" ]; then
  require_runtime
  reconcile
  exit 0
fi

if [ "$ACTION" != "deploy" ]; then
  echo "unknown action: $ACTION" >&2
  exit 2
fi

API_IMAGE="${3:?API image required}"
GATEWAY_IMAGE="${4:?gateway image required}"
WEB_IMAGE="${5:?web image required}"
COMMIT="${6:?commit required}"
require_runtime

service_status="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].status' --output text 2>/dev/null || true)"
if [ "$service_status" = "ACTIVE" ]; then
  SERVICE_WAS_ACTIVE=true
  PREVIOUS_TASK_DEFINITION="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].taskDefinition' --output text)"
fi

active_services="$(aws ecs list-services --region "$REGION" --cluster "$CLUSTER" \
  --query 'serviceArns[]' --output text)"
active_count=0
for service_arn in $active_services; do
  case "${service_arn##*/}" in
    kortix-pr-*) active_count=$((active_count + 1)) ;;
  esac
done
if [ "$active_count" -ge "$MAX_ACTIVE_PREVIEWS" ]; then
  [ "$SERVICE_WAS_ACTIVE" = true ] || {
    echo "preview quota reached: $active_count active services, limit $MAX_ACTIVE_PREVIEWS" >&2
    exit 1
  }
fi
trap rollback_deploy EXIT

VPC_ID="$(aws ec2 describe-subnets --region "$REGION" --filters Name=tag:Name,Values=kortix-dev-private-* \
  --query 'Subnets[0].VpcId' --output text)"
SUBNETS="$(aws ec2 describe-subnets --region "$REGION" --filters Name=tag:Name,Values=kortix-dev-private-* \
  --query 'Subnets[].SubnetId' --output text)"
SERVICE_SG="$(aws ec2 describe-security-groups --region "$REGION" --filters Name=group-name,Values=kortix-preview-service \
  --query 'SecurityGroups[0].GroupId' --output text)"
SECRET_ARN="$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" \
  --query ARN --output text)"
WEB_SECRET_ARN="$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$WEB_SECRET_NAME" \
  --query ARN --output text)"
LISTENER_ARN="$(listener_arn)"

[ -n "$VPC_ID" ] && [ "$VPC_ID" != "None" ] || { echo "dev VPC private subnets are unavailable" >&2; exit 1; }
[ -n "$SUBNETS" ] && [ "$SUBNETS" != "None" ] || { echo "dev VPC private subnets are unavailable" >&2; exit 1; }
read -r -a SUBNET_ARRAY <<< "$SUBNETS"
[ "${#SUBNET_ARRAY[@]}" -ge 2 ] || { echo "preview runtime requires at least two private subnets" >&2; exit 1; }
[ -n "$SERVICE_SG" ] && [ "$SERVICE_SG" != "None" ] || { echo "preview service security group is unavailable" >&2; exit 1; }
[ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != "None" ] || { echo "preview environment secret is unavailable" >&2; exit 1; }
[ -n "$WEB_SECRET_ARN" ] && [ "$WEB_SECRET_ARN" != "None" ] || { echo "preview web environment secret is unavailable" >&2; exit 1; }

API_TARGET_GROUP_ARN="$(find_target_group "$API_TARGET_GROUP_NAME")"
if [ -z "$API_TARGET_GROUP_ARN" ] || [ "$API_TARGET_GROUP_ARN" = "None" ]; then
  API_TARGET_GROUP_ARN="$(aws elbv2 create-target-group --region "$REGION" \
    --name "$API_TARGET_GROUP_NAME" --protocol HTTP --port 8008 --target-type ip --vpc-id "$VPC_ID" \
    --health-check-enabled --health-check-path /v1/health --health-check-protocol HTTP \
    --health-check-interval-seconds 15 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200-399 \
    --tags Key=Environment,Value=preview Key=ManagedBy,Value=deploy-preview-workflow Key=PR,Value="$PR" \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
fi

WEB_TARGET_GROUP_ARN="$(find_target_group "$WEB_TARGET_GROUP_NAME")"
if [ -z "$WEB_TARGET_GROUP_ARN" ] || [ "$WEB_TARGET_GROUP_ARN" = "None" ]; then
  WEB_TARGET_GROUP_ARN="$(aws elbv2 create-target-group --region "$REGION" \
    --name "$WEB_TARGET_GROUP_NAME" --protocol HTTP --port 3000 --target-type ip --vpc-id "$VPC_ID" \
    --health-check-enabled --health-check-path /api/health --health-check-protocol HTTP \
    --health-check-interval-seconds 15 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200-399 \
    --tags Key=Environment,Value=preview Key=ManagedBy,Value=deploy-preview-workflow Key=PR,Value="$PR" \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
fi

API_RULE_ARN="$(find_rule "$LISTENER_ARN" "$HOST")"
if [ -z "$API_RULE_ARN" ] || [ "$API_RULE_ARN" = "None" ]; then
  API_PRIORITY=$((PR * 2))
  API_RULE_ARN="$(aws elbv2 create-rule --region "$REGION" --listener-arn "$LISTENER_ARN" \
    --priority "$API_PRIORITY" --conditions "Field=host-header,Values=${HOST}" \
    --actions "Type=forward,TargetGroupArn=${API_TARGET_GROUP_ARN}" \
    --query 'Rules[0].RuleArn' --output text)"
else
  aws elbv2 modify-rule --region "$REGION" --rule-arn "$API_RULE_ARN" \
    --conditions "Field=host-header,Values=${HOST}" \
    --actions "Type=forward,TargetGroupArn=${API_TARGET_GROUP_ARN}" >/dev/null
fi

WEB_RULE_ARN="$(find_rule "$LISTENER_ARN" "$WEB_HOST")"
if [ -z "$WEB_RULE_ARN" ] || [ "$WEB_RULE_ARN" = "None" ]; then
  WEB_PRIORITY=$((PR * 2 + 1))
  WEB_RULE_ARN="$(aws elbv2 create-rule --region "$REGION" --listener-arn "$LISTENER_ARN" \
    --priority "$WEB_PRIORITY" --conditions "Field=host-header,Values=${WEB_HOST}" \
    --actions "Type=forward,TargetGroupArn=${WEB_TARGET_GROUP_ARN}" \
    --query 'Rules[0].RuleArn' --output text)"
else
  aws elbv2 modify-rule --region "$REGION" --rule-arn "$WEB_RULE_ARN" \
    --conditions "Field=host-header,Values=${WEB_HOST}" \
    --actions "Type=forward,TargetGroupArn=${WEB_TARGET_GROUP_ARN}" >/dev/null
fi

TASK_FILE="$(mktemp -t preview-task-XXXX.json)"
python3 - "$TASK_FILE" "$FAMILY" "$API_IMAGE" "$GATEWAY_IMAGE" "$WEB_IMAGE" "$COMMIT" \
  "$SECRET_ARN" "$WEB_SECRET_ARN" "$EXECUTION_ROLE" "$TASK_ROLE" "$LOG_GROUP" "$REGION" \
  "$HOST" "$WEB_HOST" <<'PY'
import json
import sys

(
    path,
    family,
    api_image,
    gateway_image,
    web_image,
    commit,
    secret,
    web_secret,
    execution_role,
    task_role,
    log_group,
    region,
    api_host,
    web_host,
) = sys.argv[1:]
log = lambda prefix: {
    "logDriver": "awslogs",
    "options": {"awslogs-group": log_group, "awslogs-region": region, "awslogs-stream-prefix": prefix},
}
common = [{"name": "KORTIX_ENV_JSON", "valueFrom": secret}]
web_url = f"https://{web_host}"
backend_url = f"https://{api_host}/v1"
task = {
    "family": family,
    "requiresCompatibilities": ["FARGATE"],
    "networkMode": "awsvpc",
    "cpu": "1024",
    "memory": "2048",
    "executionRoleArn": execution_role,
    "taskRoleArn": task_role,
    "containerDefinitions": [
        {
            "name": "api",
            "image": api_image,
            "essential": True,
            "portMappings": [{"containerPort": 8008, "protocol": "tcp"}],
            "environment": [
                {"name": "PORT", "value": "8008"},
                {"name": "INTERNAL_KORTIX_ENV", "value": "preview"},
                {"name": "KORTIX_COMMIT", "value": commit},
                {"name": "KORTIX_WORKERS_ENABLED", "value": "false"},
                {"name": "KORTIX_SKIP_ENSURE_SCHEMA", "value": "1"},
                {"name": "LLM_GATEWAY_PROXY_TARGET", "value": "http://127.0.0.1:8090"},
            ],
            "secrets": common,
            "logConfiguration": log("api"),
        },
        {
            "name": "gateway",
            "image": gateway_image,
            "essential": True,
            "portMappings": [{"containerPort": 8090, "protocol": "tcp"}],
            "environment": [
                {"name": "PORT", "value": "8090"},
                {"name": "INTERNAL_KORTIX_ENV", "value": "preview"},
                {"name": "KORTIX_COMMIT", "value": commit},
                {"name": "KORTIX_WORKERS_ENABLED", "value": "false"},
                {"name": "KORTIX_API_URL", "value": "http://127.0.0.1:8008"},
            ],
            "secrets": common,
            "logConfiguration": log("gateway"),
        },
        {
            "name": "web",
            "image": web_image,
            "essential": True,
            "portMappings": [{"containerPort": 3000, "protocol": "tcp"}],
            "environment": [
                {"name": "PORT", "value": "3000"},
                {"name": "NEXT_PUBLIC_APP_URL", "value": web_url},
                {"name": "KORTIX_PUBLIC_APP_URL", "value": web_url},
                {"name": "NEXT_PUBLIC_URL", "value": web_url},
                {"name": "NEXT_PUBLIC_BACKEND_URL", "value": backend_url},
                {"name": "KORTIX_PUBLIC_BACKEND_URL", "value": backend_url},
                {"name": "BACKEND_URL", "value": backend_url},
                {
                    "name": "KORTIX_PUBLIC_VERSION",
                    "value": f"pr-{family.removeprefix('kortix-pr-')}",
                },
                {"name": "WEB_PROTECTION_ENABLED", "value": "true"},
            ],
            "secrets": [{"name": "KORTIX_ENV_JSON", "valueFrom": web_secret}],
            "logConfiguration": log("web"),
        },
    ],
    "tags": [
        {"key": "Environment", "value": "preview"},
        {"key": "ManagedBy", "value": "deploy-preview-workflow"},
        {"key": "PR", "value": family.removeprefix("kortix-pr-")},
    ],
}
with open(path, "w", encoding="utf-8") as stream:
    json.dump(task, stream)
PY

TASK_DEFINITION="$(aws ecs register-task-definition --region "$REGION" --cli-input-json "file://${TASK_FILE}" \
  --query 'taskDefinition.taskDefinitionArn' --output text)"

if aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].status' --output text 2>/dev/null | grep -qx ACTIVE; then
  aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
    --task-definition "$TASK_DEFINITION" --desired-count 1 --force-new-deployment \
    --load-balancers \
      "targetGroupArn=${API_TARGET_GROUP_ARN},containerName=api,containerPort=8008" \
      "targetGroupArn=${WEB_TARGET_GROUP_ARN},containerName=web,containerPort=3000" \
    --health-check-grace-period-seconds 60 >/dev/null
else
  SUBNET_CSV="$(IFS=,; echo "${SUBNET_ARRAY[*]}")"
  aws ecs create-service --region "$REGION" --cluster "$CLUSTER" --service-name "$SERVICE" \
    --task-definition "$TASK_DEFINITION" --desired-count 1 \
    --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_CSV}],securityGroups=[${SERVICE_SG}],assignPublicIp=DISABLED}" \
    --load-balancers \
      "targetGroupArn=${API_TARGET_GROUP_ARN},containerName=api,containerPort=8008" \
      "targetGroupArn=${WEB_TARGET_GROUP_ARN},containerName=web,containerPort=3000" \
    --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100' \
    --health-check-grace-period-seconds 60 \
    --propagate-tags TASK_DEFINITION \
    --tags key=Environment,value=preview key=ManagedBy,value=deploy-preview-workflow key=PR,value="$PR" >/dev/null
fi

aws ecs wait services-stable --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE"

task_definitions="$(aws ecs list-task-definitions --region "$REGION" --family-prefix "$FAMILY" \
  --status ACTIVE --query 'taskDefinitionArns[]' --output text)"
for task_definition in $task_definitions; do
  if [ "$task_definition" != "$TASK_DEFINITION" ]; then
    aws ecs deregister-task-definition --region "$REGION" --task-definition "$task_definition" >/dev/null
  fi
done
echo "preview $PR deployed: $TASK_DEFINITION"
trap - EXIT
rm -f "$TASK_FILE"
