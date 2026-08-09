#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:?usage: ecs-preview.sh deploy|teardown <pr-number> [api-image] [gateway-image] [commit]}"
PR="${2:?PR number required}"

if ! [[ "$PR" =~ ^[1-9][0-9]*$ ]] || [ "$PR" -gt 40000 ]; then
  echo "invalid PR number: $PR" >&2
  exit 2
fi

REGION="${AWS_REGION:-us-west-2}"
CLUSTER="kortix-preview"
SERVICE="kortix-pr-${PR}"
FAMILY="$SERVICE"
TARGET_GROUP_NAME="kortix-pr-${PR}"
HOST="pr-${PR}.preview-api.kortix.com"
SECRET_NAME="kortix-preview-env"
EXECUTION_ROLE="arn:aws:iam::935064898258:role/kortix-preview-exec"
TASK_ROLE="arn:aws:iam::935064898258:role/kortix-preview-task"
LOG_GROUP="/ecs/kortix-preview"

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
  aws_text aws elbv2 describe-listeners --region "$REGION" --load-balancer-arn "$alb" \
    --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text
}

find_rule() {
  aws elbv2 describe-rules --region "$REGION" --listener-arn "$1" \
    --output json 2>/dev/null \
    | jq -r --arg host "$HOST" \
      '[.Rules[] | select(any(.Conditions[]?; .Field == "host-header" and any(.Values[]?; . == $host))) | .RuleArn][0] // empty' \
    || true
}

find_target_group() {
  aws elbv2 describe-target-groups --region "$REGION" --names "$TARGET_GROUP_NAME" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true
}

teardown() {
  local listener rule target_group task_definitions
  if ! aws ecs describe-clusters --region "$REGION" --clusters "$CLUSTER" \
    --query 'clusters[0].status' --output text 2>/dev/null | grep -qx ACTIVE; then
    echo "preview runtime is absent; preview $PR is already torn down"
    return
  fi
  listener="$(listener_arn 2>/dev/null || true)"
  rule=""
  if [ -n "$listener" ]; then
    rule="$(find_rule "$listener")"
  fi
  if [ -n "$rule" ] && [ "$rule" != "None" ]; then
    aws elbv2 delete-rule --region "$REGION" --rule-arn "$rule"
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

  target_group="$(find_target_group)"
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

  task_definitions="$(aws ecs list-task-definitions --region "$REGION" --family-prefix "$FAMILY" \
    --status ACTIVE --query 'taskDefinitionArns[]' --output text)"
  for task_definition in $task_definitions; do
    aws ecs deregister-task-definition --region "$REGION" --task-definition "$task_definition" >/dev/null
  done
  echo "preview $PR torn down"
}

if [ "$ACTION" = "teardown" ]; then
  teardown
  exit 0
fi

if [ "$ACTION" != "deploy" ]; then
  echo "unknown action: $ACTION" >&2
  exit 2
fi

API_IMAGE="${3:?API image required}"
GATEWAY_IMAGE="${4:?gateway image required}"
COMMIT="${5:?commit required}"
require_runtime

VPC_ID="$(aws ec2 describe-subnets --region "$REGION" --filters Name=tag:Name,Values=kortix-dev-private-* \
  --query 'Subnets[0].VpcId' --output text)"
SUBNETS="$(aws ec2 describe-subnets --region "$REGION" --filters Name=tag:Name,Values=kortix-dev-private-* \
  --query 'Subnets[].SubnetId' --output text)"
SERVICE_SG="$(aws ec2 describe-security-groups --region "$REGION" --filters Name=group-name,Values=kortix-preview-service \
  --query 'SecurityGroups[0].GroupId' --output text)"
SECRET_ARN="$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" \
  --query ARN --output text)"
LISTENER_ARN="$(listener_arn)"

[ -n "$VPC_ID" ] && [ "$VPC_ID" != "None" ] || { echo "dev VPC private subnets are unavailable" >&2; exit 1; }
[ -n "$SUBNETS" ] && [ "$SUBNETS" != "None" ] || { echo "dev VPC private subnets are unavailable" >&2; exit 1; }
read -r -a SUBNET_ARRAY <<< "$SUBNETS"
[ "${#SUBNET_ARRAY[@]}" -ge 2 ] || { echo "preview runtime requires at least two private subnets" >&2; exit 1; }
[ -n "$SERVICE_SG" ] && [ "$SERVICE_SG" != "None" ] || { echo "preview service security group is unavailable" >&2; exit 1; }
[ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != "None" ] || { echo "preview environment secret is unavailable" >&2; exit 1; }

TARGET_GROUP_ARN="$(find_target_group)"
if [ -z "$TARGET_GROUP_ARN" ] || [ "$TARGET_GROUP_ARN" = "None" ]; then
  TARGET_GROUP_ARN="$(aws elbv2 create-target-group --region "$REGION" \
    --name "$TARGET_GROUP_NAME" --protocol HTTP --port 8008 --target-type ip --vpc-id "$VPC_ID" \
    --health-check-enabled --health-check-path /v1/health --health-check-protocol HTTP \
    --health-check-interval-seconds 15 --health-check-timeout-seconds 5 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 --matcher HttpCode=200-399 \
    --tags Key=Environment,Value=preview Key=ManagedBy,Value=deploy-preview-workflow Key=PR,Value="$PR" \
    --query 'TargetGroups[0].TargetGroupArn' --output text)"
fi

RULE_ARN="$(find_rule "$LISTENER_ARN")"
if [ -z "$RULE_ARN" ] || [ "$RULE_ARN" = "None" ]; then
  PRIORITY=$((10000 + PR))
  RULE_ARN="$(aws elbv2 create-rule --region "$REGION" --listener-arn "$LISTENER_ARN" \
    --priority "$PRIORITY" --conditions "Field=host-header,Values=${HOST}" \
    --actions "Type=forward,TargetGroupArn=${TARGET_GROUP_ARN}" \
    --query 'Rules[0].RuleArn' --output text)"
else
  aws elbv2 modify-rule --region "$REGION" --rule-arn "$RULE_ARN" \
    --conditions "Field=host-header,Values=${HOST}" \
    --actions "Type=forward,TargetGroupArn=${TARGET_GROUP_ARN}" >/dev/null
fi

TASK_FILE="$(mktemp -t preview-task-XXXX.json)"
trap 'rm -f "$TASK_FILE"' EXIT
python3 - "$TASK_FILE" "$FAMILY" "$API_IMAGE" "$GATEWAY_IMAGE" "$COMMIT" "$SECRET_ARN" \
  "$EXECUTION_ROLE" "$TASK_ROLE" "$LOG_GROUP" "$REGION" <<'PY'
import json
import sys

path, family, api_image, gateway_image, commit, secret, execution_role, task_role, log_group, region = sys.argv[1:]
log = lambda prefix: {
    "logDriver": "awslogs",
    "options": {"awslogs-group": log_group, "awslogs-region": region, "awslogs-stream-prefix": prefix},
}
common = [{"name": "KORTIX_ENV_JSON", "valueFrom": secret}]
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
    --health-check-grace-period-seconds 60 >/dev/null
else
  SUBNET_CSV="$(IFS=,; echo "${SUBNET_ARRAY[*]}")"
  aws ecs create-service --region "$REGION" --cluster "$CLUSTER" --service-name "$SERVICE" \
    --task-definition "$TASK_DEFINITION" --desired-count 1 \
    --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1 \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_CSV}],securityGroups=[${SERVICE_SG}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${TARGET_GROUP_ARN},containerName=api,containerPort=8008" \
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
