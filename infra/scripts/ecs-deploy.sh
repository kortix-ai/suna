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
#
# Rollout stabilization is bounded by ECS_STABILIZE_TIMEOUT_SECONDS (default
# 900) and polled every ECS_STABILIZE_POLL_SECONDS (default 15). A FAILED
# rolloutState exits immediately. A timeout or failure prints the service's last
# ECS_DIAGNOSTIC_EVENT_LIMIT events (default 10), every deployment's counts and
# rolloutStateReason, up to ECS_DIAGNOSTIC_TASK_LIMIT stopped-task reasons
# (default 5), and the awslogs group the new tasks write to.

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

# ── rollout stabilization: budget + diagnostics ──────────────────────────────
# `aws ecs wait services-stable` is a FIXED 40 attempts x 15s = 600s, and on
# expiry it prints only "Max attempts exceeded" — which cannot distinguish "the
# roll is slow" from "the new task crash-loops". The dev frontend roll already
# lands at 7m53s (run 35382033823), so that waiter left ~2 minutes of headroom
# and failed run 35388160843 / job 105741051220 on a healthy image. This script
# also rolls staging and prod, so the same margin failed a production deploy for
# no product reason. The poll below owns the budget AND prints what a human needs
# to decide whether the built image is safe to promote.
#
# The budget is declared ONCE, here. Do not hardcode a second value elsewhere.
ECS_STABILIZE_TIMEOUT_SECONDS="${ECS_STABILIZE_TIMEOUT_SECONDS:-900}"
ECS_STABILIZE_POLL_SECONDS="${ECS_STABILIZE_POLL_SECONDS:-15}"
ECS_DIAGNOSTIC_EVENT_LIMIT="${ECS_DIAGNOSTIC_EVENT_LIMIT:-10}"
ECS_DIAGNOSTIC_TASK_LIMIT="${ECS_DIAGNOSTIC_TASK_LIMIT:-5}"

describe_service_json() {
  aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
    --services "$SERVICE" --output json 2>/dev/null || true
}

# Stopped-task reasons are the only evidence that separates "slow" from
# "crash-looping". Capped at ECS_DIAGNOSTIC_TASK_LIMIT tasks — never a megabyte
# dump. Soft-fails throughout: diagnostics must not mask the rollout verdict.
print_stopped_task_diagnostics() {
  local task_arns tasks_json arn
  local -a arns=()

  task_arns="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" \
    --service-name "$SERVICE" --desired-status STOPPED \
    --max-items "$ECS_DIAGNOSTIC_TASK_LIMIT" \
    --query 'taskArns' --output json 2>/dev/null || true)"

  # `--query taskArns` yields a bare array, but a paginated call can answer an
  # object that still carries it. Accept either, and take only strings so a
  # NextToken or a nested array can never be counted as a task.
  while IFS= read -r arn; do
    [ -n "$arn" ] || continue
    arns+=("$arn")
  done < <(printf '%s' "$task_arns" \
    | jq -r '(if type == "object" then (.taskArns // []) else . end)[]? | select(type == "string")' \
      2>/dev/null || true)

  if [ "${#arns[@]}" -eq 0 ]; then
    echo "  stopped tasks: none — the roll is slow, not crash-looping" >&2
    return 0
  fi

  tasks_json="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" \
    --tasks "${arns[@]}" --output json 2>/dev/null || true)"

  echo "  stopped tasks (newest ${#arns[@]}):" >&2
  printf '%s' "$tasks_json" | jq -r '
    (.tasks // [])[]
    | "    task=\((.taskArn // "?") | split("/") | last) lastStatus=\(.lastStatus // "?") stopCode=\(.stopCode // "-")\n" +
      "      stoppedReason=\(.stoppedReason // "-")\n" +
      ((.containers // [])
        | map("      container=\(.name // "?") exitCode=\(if .exitCode == null then "-" else .exitCode end) reason=\(.reason // "-")")
        | join("\n"))' >&2 2>/dev/null || true
}

# A copy-pasteable log command beats a log group name. Reads the task-def this
# roll registered, so it names the stream prefix the NEW tasks write under.
print_awslogs_hint() {
  local group prefix
  group="$(printf '%s' "${NEW_TD_JSON:-}" | jq -r --arg c "$CONTAINER" '
    [.containerDefinitions[]? | select(.name == $c)
     | select((.logConfiguration.logDriver // "") == "awslogs")
     | .logConfiguration.options["awslogs-group"] // empty][0] // empty' 2>/dev/null || true)"
  [ -n "$group" ] || return 0
  prefix="$(printf '%s' "${NEW_TD_JSON:-}" | jq -r --arg c "$CONTAINER" '
    [.containerDefinitions[]? | select(.name == $c)
     | .logConfiguration.options["awslogs-stream-prefix"] // empty][0] // empty' 2>/dev/null || true)"
  echo "  CloudWatch: group=$group stream=${prefix:-<none>}/$CONTAINER/<task-id>" >&2
  echo "    aws logs tail $group --region $REGION --since 20m --follow" >&2
}

print_rollout_diagnostics() {
  local service_json="${1:-}"
  echo "── rollout diagnostics: $CLUSTER/$SERVICE ($REGION) ──" >&2

  [ -n "$service_json" ] || service_json="$(describe_service_json)"
  if [ -z "$service_json" ]; then
    echo "  describe-services returned nothing — cannot read service state" >&2
    return 0
  fi

  echo "  deployments:" >&2
  printf '%s' "$service_json" | jq -r '
    (.services[0].deployments // [])[]
    | "    status=\(.status // "?") rolloutState=\(.rolloutState // "?") desired=\(.desiredCount // 0) running=\(.runningCount // 0) pending=\(.pendingCount // 0)\n" +
      "      taskDefinition=\(.taskDefinition // "?")\n" +
      "      rolloutStateReason=\(.rolloutStateReason // "-")"' >&2 2>/dev/null || true

  echo "  last $ECS_DIAGNOSTIC_EVENT_LIMIT service events (newest first):" >&2
  printf '%s' "$service_json" | jq -r --argjson n "$ECS_DIAGNOSTIC_EVENT_LIMIT" '
    (.services[0].events // [])[:$n][]
    | "    \(.createdAt // "?")  \(.message // "")"' >&2 2>/dev/null || true

  print_stopped_task_diagnostics
  print_awslogs_hint
}

# Returns 0 only for a COMPLETED rollout whose running count caught up with the
# desired count. A FAILED rolloutState returns immediately — it never burns the
# remaining budget. Both failure paths print diagnostics before returning.
wait_for_stable_rollout() {
  local budget="$1" delay="$2"
  local started deadline now remaining service_json summary
  local rollout="" running="" desired="" pending=""
  started="$(date +%s)"
  deadline=$(( started + budget ))

  while : ; do
    service_json="$(describe_service_json)"
    if [ -n "$service_json" ]; then
      summary="$(printf '%s' "$service_json" | jq -r '
        (.services[0] // {}) as $s
        | (($s.deployments // []) | map(select(.status == "PRIMARY")) | .[0] // {}) as $d
        | [$d.rolloutState // "UNKNOWN",
           ($s.runningCount // 0 | tostring),
           ($s.desiredCount // 0 | tostring),
           ($s.pendingCount // 0 | tostring)]
        | @tsv' 2>/dev/null || true)"
      if [ -n "$summary" ]; then
        IFS=$'\t' read -r rollout running desired pending <<<"$summary"
      fi

      case "$rollout" in
        COMPLETED)
          if [ "$running" = "$desired" ] && [ "$pending" = "0" ]; then
            echo "✔ rollout COMPLETED in $(( $(date +%s) - started ))s (running=$running desired=$desired)"
            return 0
          fi
          ;;
        FAILED)
          echo "✖ rollout FAILED after $(( $(date +%s) - started ))s — not waiting out the remaining budget" >&2
          print_rollout_diagnostics "$service_json"
          return 1
          ;;
      esac
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      echo "✖ rollout did not stabilize within ${budget}s (rolloutState=${rollout:-unknown} running=${running:-?} desired=${desired:-?} pending=${pending:-?})" >&2
      print_rollout_diagnostics "$service_json"
      return 1
    fi
    remaining=$(( deadline - now ))
    if [ "$remaining" -lt "$delay" ]; then
      sleep "$remaining"
    else
      sleep "$delay"
    fi
  done
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
  echo "⏳ waiting for the rollout to stabilize (budget ${ECS_STABILIZE_TIMEOUT_SECONDS}s, poll ${ECS_STABILIZE_POLL_SECONDS}s) …"
  wait_for_stable_rollout "$ECS_STABILIZE_TIMEOUT_SECONDS" "$ECS_STABILIZE_POLL_SECONDS"
  aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].{running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}' \
    --output table
fi
echo "✅ $ENV/$CONTAINER now on $IMAGE ($NEW_TD)"
