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
#   ecs-deploy.sh <env> <image> [--service api|gateway|web|worker]
#                 [--version X.Y.Z] [--database-migrated] [--no-wait]
#                 [--wait-for serving|stable] [--process-role auto|all]
#                 [--dry-run]
#
#   env        dev-use2 | staging-euw2 | prod
#              (dev-use2 and staging-euw2 are infra/terraform/environments/
#              dev-us-east-2 and staging-eu-west-2)
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
#              registering or rolling anything. With ECS_DEPLOY_RENDERED_ENV_FILE
#              set, it also writes the target container's rendered environment
#              (a JSON array of {name, value}) to that path, mode 0600. Deploy
#              Dev's release gate runs the new image with exactly that
#              environment, so it computes the same sandbox image identity the
#              rolled tasks will.
#   --wait-for stable (default) returns when the rollout is COMPLETED and the
#              service runs exactly the desired count, i.e. after every old
#              task has drained and stopped. serving returns as soon as every
#              task ECS keeps running is on the NEW revision; the old tasks
#              still drain (deregistration_delay) in the background. ECS only
#              stops an old task after its replacement passes the target-group
#              health check, so "no old task left with desired status RUNNING"
#              means the new revision takes all new requests. Measured on dev
#              2026-09-26: the API served only the new commit ~80 s before the
#              stable wait returned. Deploy Dev uses serving; staging and prod
#              keep stable, where a roll must be fully settled before the next
#              gate runs. Both modes accept only the revision this run
#              registered. A circuit-breaker rollback, or any PRIMARY on
#              another revision, exits 1 with the new revision's stopped-task
#              reasons.
#   --database-migrated
#              required for a live prod rollout. This is an explicit
#              assertion that the environment's migration job passed.
#              It prevents an emergency direct ECS roll from silently bypassing
#              the database gate.
#   --service worker
#              the scheduled-job worker (<prefix>-worker in the API cluster,
#              container `worker`, modules/ecs-api var.worker). Its environment
#              is COPIED from the API service's running task definition
#              (container `api`), then KORTIX_ECS_ENV_OVERRIDES and
#              LLM_GATEWAY_PROXY_TARGET apply as for the API,
#              KORTIX_PROCESS_ROLE is removed, and KORTIX_WORKER_ENV_FROM is set
#              to the API task definition ARN it was copied from (the mark of a
#              revision this script registered). The API environment holds keys
#              that only ever came from deploy overrides; the worker must run
#              with the API's real configuration. The roll sets desired count 1
#              (Terraform creates the service at 0) and always waits `stable`,
#              whatever --wait-for says: the old worker hands the leader lease
#              over only when it stops. Roll it BEFORE the API.
#   --process-role auto|all
#              --service api only. Sets KORTIX_PROCESS_ROLE in the API task
#              environment, whatever the running revision carries. `auto`
#              (default) chooses `web` (the API runs no scheduled job) only when
#              the worker service is ACTIVE, its PRIMARY deployment is
#              COMPLETED, that revision's `worker` container carries
#              KORTIX_WORKER_ENV_FROM (Terraform's first revision does not) and
#              runs <image>, and a task of that revision is RUNNING and HEALTHY.
#              Anything else is
#              `all` (the API runs the jobs, as before the worker existed) with a
#              ::warning naming the failed condition. `all` forces `all`: the
#              kill switch. After an API rollout that ends with `all`, the
#              script scales the worker service to 0, so an older worker cannot
#              keep the leader lease; the next --service worker roll sets 1.
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
# rolloutStateReason, the lastStatus breakdown of up to
# ECS_DIAGNOSTIC_TASK_LIMIT live tasks (default 5) with any container reason,
# the same number of stopped-task exit reasons, and the awslogs group the new
# tasks write to. These are OBSERVATIONS: the script reports what the service
# says and never concludes a cause from an absence of evidence.

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
    worker)
      # The ecs-api module puts the worker in the API's cluster.
      CLUSTER="$SERVICE_PREFIX"
      SERVICE="${SERVICE_PREFIX}-worker"
      CONTAINER="worker"
      ;;
    *)
      echo "unknown service: $service_kind (expected api|gateway|web|worker)" >&2
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
    prod) printf '%s' 'https://gateway-ecs-fargate.kortix.com' ;;
    dev-use2) printf '%s' 'https://gateway-dev-use2.kortix.com' ;;
    staging-euw2) printf '%s' 'https://gateway-staging-euw2.kortix.com' ;;
    *) echo "unknown gateway environment: $1" >&2; return 2 ;;
  esac
}

# Sets REGION, SERVICE_PREFIX (cluster/service name stem) and SECRET_NAME.
configure_env_coordinates() {
  case "$1" in
    prod)             REGION="eu-west-2"; SERVICE_PREFIX="kortix-prod";         SECRET_NAME="kortix-prod-env" ;;
    # The env blob keeps the environment's name; it lives in the stack's region.
    dev-use2)         REGION="us-east-2"; SERVICE_PREFIX="kortix-dev-use2";     SECRET_NAME="kortix-dev-env" ;;
    staging-euw2)     REGION="eu-west-2"; SERVICE_PREFIX="kortix-staging-euw2"; SECRET_NAME="kortix-staging-env" ;;
    *) echo "unknown env: $1" >&2; return 2 ;;
  esac
}

# ── rollout stabilization: budget + diagnostics ──────────────────────────────
# `aws ecs wait services-stable` is a FIXED 40 attempts x 15s = 600s, and on
# expiry it prints only "Max attempts exceeded" — a message that reports no
# service state at all. The last successful dev frontend roll (run 35382033823)
# spent ~7m23s in its waiter (7m53s job wall-clock minus ~30s of register +
# update-service overhead, measured on the failing job), so that budget left
# about 2.5 minutes of headroom and then failed run 35388160843 /
# job 105741051220. This script also rolls staging and prod, so the same margin
# fails a production deploy for no product reason. The poll below owns the
# budget AND prints the service state a human needs to decide whether the built
# image is safe to promote.
#
# The budget is declared ONCE, here. Do not hardcode a second value elsewhere.
ECS_STABILIZE_TIMEOUT_SECONDS="${ECS_STABILIZE_TIMEOUT_SECONDS:-900}"
ECS_STABILIZE_POLL_SECONDS="${ECS_STABILIZE_POLL_SECONDS:-15}"
ECS_DIAGNOSTIC_EVENT_LIMIT="${ECS_DIAGNOSTIC_EVENT_LIMIT:-10}"
ECS_DIAGNOSTIC_TASK_LIMIT="${ECS_DIAGNOSTIC_TASK_LIMIT:-5}"
# A worker roll from 0 tasks waits this long for the earlier deployments to leave
# before it raises the count (see "roll the service").
ECS_WORKER_SWITCH_WAIT_SECONDS="${ECS_WORKER_SWITCH_WAIT_SECONDS:-120}"

describe_service_json() {
  aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
    --services "$SERVICE" --output json 2>/dev/null || true
}

# Stopped-task exit reasons are ONE kind of evidence a reader needs: they show a
# task that died and why. Their ABSENCE proves nothing on its own — a rollout
# can be wedged with tasks still in PENDING (image pull, no capacity, a health
# check below its threshold), in which case nothing has stopped yet. Report the
# observation; let the reader combine it with the counts, the events and the
# live-task breakdown. Capped at ECS_DIAGNOSTIC_TASK_LIMIT tasks — never a
# megabyte dump. Soft-fails throughout: diagnostics must not mask the verdict.
#
# With a task definition in $1, it reads up to 100 stopped tasks and reports
# only those of that revision: after a rollback, the tasks of the new revision
# are the ones whose exit reason explains the failure.
print_stopped_task_diagnostics() {
  local task_def="${1:-}" task_arns tasks_json arn count scan_limit="$ECS_DIAGNOSTIC_TASK_LIMIT"
  local -a arns=()
  [ -z "$task_def" ] || scan_limit=100

  task_arns="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" \
    --service-name "$SERVICE" --desired-status STOPPED \
    --max-items "$scan_limit" \
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
    echo "  stopped tasks: none in the window — no exit reasons to report." >&2
    echo "    this does NOT mean the roll is merely slow: a rollout can be wedged" >&2
    echo "    with tasks still in PENDING (image pull, capacity/subnet IPs, a" >&2
    echo "    health check below its threshold). Read the counts, the live-task" >&2
    echo "    breakdown and the events above." >&2
    return 0
  fi

  tasks_json="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" \
    --tasks "${arns[@]}" --output json 2>/dev/null || true)"

  tasks_json="$(printf '%s' "$tasks_json" | jq -c --arg td "$task_def" --argjson n "$ECS_DIAGNOSTIC_TASK_LIMIT" '
    {tasks: ([(.tasks // [])[] | select($td == "" or .taskDefinitionArn == $td)] | .[:$n])}' 2>/dev/null || true)"
  count="$(printf '%s' "$tasks_json" | jq -r '.tasks | length' 2>/dev/null || true)"
  if [ "${count:-0}" = 0 ]; then
    echo "  stopped tasks: none of ${task_def:-the service} among the last ${#arns[@]} stopped tasks." >&2
    return 0
  fi

  echo "  stopped tasks${task_def:+ of $task_def} (newest $count):" >&2
  printf '%s' "$tasks_json" | jq -r '
    (.tasks // [])[]
    | "    task=\((.taskArn // "?") | split("/") | last) lastStatus=\(.lastStatus // "?") stopCode=\(.stopCode // "-")\n" +
      "      stoppedReason=\(.stoppedReason // "-")\n" +
      ((.containers // [])
        | map("      container=\(.name // "?") exitCode=\(if .exitCode == null then "-" else .exitCode end) reason=\(.reason // "-")")
        | join("\n"))' >&2 2>/dev/null || true
}

# The PENDING wedge leaves nothing STOPPED, so the lastStatus breakdown of the
# tasks ECS still WANTS running is what discriminates it. A task blocked on an
# image pull, on capacity, or on a health check below its threshold sits in
# PENDING/PROVISIONING/ACTIVATING and never reaches STOPPED inside the window.
# Filtering on `--desired-status RUNNING` is what returns those tasks: their
# desired status is RUNNING even while their last status is PENDING.
# Container-level `reason` is printed only when ECS set one, which keeps this to
# a couple of lines on a healthy-but-slow roll and names the cause on a wedge.
print_live_task_diagnostics() {
  local task_arns tasks_json arn
  local -a arns=()

  task_arns="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" \
    --service-name "$SERVICE" --desired-status RUNNING \
    --max-items "$ECS_DIAGNOSTIC_TASK_LIMIT" \
    --query 'taskArns' --output json 2>/dev/null || true)"

  while IFS= read -r arn; do
    [ -n "$arn" ] || continue
    arns+=("$arn")
  done < <(printf '%s' "$task_arns" \
    | jq -r '(if type == "object" then (.taskArns // []) else . end)[]? | select(type == "string")' \
      2>/dev/null || true)

  if [ "${#arns[@]}" -eq 0 ]; then
    echo "  live tasks: none with desired status RUNNING in the window." >&2
    return 0
  fi

  tasks_json="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" \
    --tasks "${arns[@]}" --output json 2>/dev/null || true)"

  echo "  live tasks by lastStatus (desired RUNNING, newest ${#arns[@]}):" >&2
  printf '%s' "$tasks_json" | jq -r '
    (.tasks // [])
    | if length == 0 then "    (no task detail returned)"
      else "    " + (group_by(.lastStatus // "UNKNOWN")
           | map("\(.[0].lastStatus // "UNKNOWN")=\(length)") | join(" "))
      end' >&2 2>/dev/null || true
  printf '%s' "$tasks_json" | jq -r '
    (.tasks // [])[]
    | . as $task
    | ((.containers // []) | map(select((.reason // "") != "")) | .[]?)
    | "      task=\(($task.taskArn // "?") | split("/") | last) lastStatus=\($task.lastStatus // "?") container=\(.name // "?") reason=\(.reason // "-")"' >&2 2>/dev/null || true
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
  # Only name the stream when a prefix exists: `<prefix>/<container>/<task-id>`
  # is the awslogs layout. With no prefix the driver names the stream after the
  # container id instead, so printing "<none>/..." would name a stream that
  # cannot exist.
  if [ -n "$prefix" ]; then
    echo "  CloudWatch: group=$group stream=$prefix/$CONTAINER/<task-id>" >&2
  else
    echo "  CloudWatch: group=$group (task-def declares no awslogs-stream-prefix)" >&2
  fi
  echo "    aws logs tail $group --region $REGION --since 20m --follow" >&2
}

print_rollout_diagnostics() {
  local service_json="${1:-}" task_def="${2:-}"
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

  print_live_task_diagnostics
  print_stopped_task_diagnostics "$task_def"
  print_awslogs_hint
}

# Returns 0 when every task ECS keeps running (desired status RUNNING) is on
# task definition $1, is RUNNING, and there are exactly $2 of them. An old task
# that is draining has desired status STOPPED, so it does not count.
new_revision_serving() {
  local task_def="$1" want="$2" task_arns tasks_json arn
  local -a arns=()

  task_arns="$(aws ecs list-tasks --region "$REGION" --cluster "$CLUSTER" \
    --service-name "$SERVICE" --desired-status RUNNING \
    --query 'taskArns' --output json 2>/dev/null || true)"
  while IFS= read -r arn; do
    [ -n "$arn" ] || continue
    arns+=("$arn")
  done < <(printf '%s' "$task_arns" \
    | jq -r '(if type == "object" then (.taskArns // []) else . end)[]? | select(type == "string")' \
      2>/dev/null || true)
  [ "${#arns[@]}" -eq "$want" ] || return 1

  tasks_json="$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" \
    --tasks "${arns[@]}" --output json 2>/dev/null || true)"
  printf '%s' "$tasks_json" | jq -e --arg td "$task_def" --argjson want "$want" '
    (.tasks // []) as $t
    | ($t | length) == $want
      and ($t | all(.taskDefinitionArn == $td and .lastStatus == "RUNNING"))' \
    >/dev/null 2>&1
}

# Returns 0 for a COMPLETED rollout of task definition $4 (the revision this
# roll registered) whose running count caught up with the desired count. With
# mode `serving`, it also returns 0 as soon as new_revision_serving holds for
# $4. Returns 1 immediately, without burning the remaining budget, when the
# deployment of $4 is FAILED or when the PRIMARY deployment runs any other
# revision: the circuit breaker rolled back, or another roll superseded this
# one. A rollback deployment reaches COMPLETED with every task RUNNING, so a
# check that reads only the PRIMARY deployment accepts it as success (dev API,
# 2026-09-28: four deploys reported SERVING on the old revision). Every failure
# path prints diagnostics, including the stopped tasks of $4.
wait_for_stable_rollout() {
  local budget="$1" delay="$2" mode="${3:-stable}" expected_td="${4:-}"
  local started deadline now remaining service_json summary
  local rollout="" running="" desired="" pending=""
  local primary_td="" primary_running="" primary_desired="" primary_pending=""
  local expected_state="" expected_reason="" seen_expected=0 grace_end
  if [ -z "$expected_td" ]; then
    echo "wait_for_stable_rollout: the registered task definition is required" >&2
    return 2
  fi
  started="$(date +%s)"
  deadline=$(( started + budget ))
  # describe-services is eventually consistent. Until the deployment of
  # $expected_td shows up once, a PRIMARY on another revision can be a stale
  # read right after update-service, so it fails only after this grace.
  grace_end=$(( started + 60 ))

  while : ; do
    service_json="$(describe_service_json)"
    if [ -n "$service_json" ]; then
      summary="$(printf '%s' "$service_json" | jq -r --arg td "$expected_td" '
        (.services[0] // {}) as $s
        | (($s.deployments // []) | map(select(.status == "PRIMARY")) | .[0] // {}) as $d
        | (($s.deployments // []) | map(select(.taskDefinition == $td)) | .[0] // {}) as $e
        | [$d.rolloutState // "UNKNOWN",
           ($s.runningCount // 0 | tostring),
           ($s.desiredCount // 0 | tostring),
           ($s.pendingCount // 0 | tostring),
           ($d.taskDefinition // "-"),
           ($d.runningCount // 0 | tostring),
           ($d.desiredCount // 0 | tostring),
           ($d.pendingCount // 0 | tostring),
           ($e.rolloutState // "-"),
           (($e.rolloutStateReason // "-") | gsub("[\t\n]"; " "))]
        | @tsv' 2>/dev/null || true)"
      if [ -n "$summary" ]; then
        IFS=$'\t' read -r rollout running desired pending \
          primary_td primary_running primary_desired primary_pending \
          expected_state expected_reason <<<"$summary"
      fi

      [ "${expected_state:--}" = - ] || seen_expected=1
      now="$(date +%s)"
      if [ -n "$primary_td" ] && [ "$primary_td" != "$expected_td" ] \
        && { [ "$seen_expected" = 1 ] || [ "$now" -ge "$grace_end" ] || [ "$now" -ge "$deadline" ]; }; then
        echo "✖ rollout of $expected_td did not take: the PRIMARY deployment runs $primary_td (rolloutState=$rollout); the deployment of $expected_td is ${expected_state:--} (${expected_reason:--}). ECS rolled back or another roll superseded this one." >&2
        [ -z "${GITHUB_ACTIONS:-}" ] \
          || echo "::error title=ECS rollout rolled back::$SERVICE is not on $expected_td; it runs $primary_td. ${expected_reason:-}" >&2
        print_rollout_diagnostics "$service_json" "$expected_td"
        return 1
      fi

      case "$rollout" in
        COMPLETED)
          if [ "$primary_td" = "$expected_td" ] && [ "$running" = "$desired" ] && [ "$pending" = "0" ]; then
            echo "✔ rollout COMPLETED in $(( $(date +%s) - started ))s (running=$running desired=$desired)"
            return 0
          fi
          ;;
        FAILED)
          echo "✖ rollout FAILED after $(( $(date +%s) - started ))s (running=$running desired=$desired pending=$pending) — not waiting out the remaining budget" >&2
          print_rollout_diagnostics "$service_json" "$expected_td"
          return 1
          ;;
      esac

      if [ "$mode" = serving ] && [ "$primary_td" = "$expected_td" ] \
        && [ "$primary_desired" = "$desired" ] \
        && [ "${primary_desired:-0}" -gt 0 ] 2>/dev/null \
        && [ "$primary_running" = "$primary_desired" ] && [ "$primary_pending" = "0" ] \
        && new_revision_serving "$expected_td" "$primary_desired"; then
        echo "✔ rollout SERVING in $(( $(date +%s) - started ))s: all $primary_desired tasks ECS keeps running are on $expected_td; old tasks drain in the background (service running=$running)"
        return 0
      fi
    fi

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      # The mismatch check above read the clock before describe-services
      # returned, so a slow call can cross the deadline between the two reads.
      # Name the revision the PRIMARY runs whenever it is not ours.
      if [ -n "$primary_td" ] && [ "$primary_td" != "$expected_td" ]; then
        echo "✖ rollout of $expected_td did not take: the PRIMARY deployment runs $primary_td (rolloutState=$rollout); the deployment of $expected_td is ${expected_state:--} (${expected_reason:--}). ECS rolled back or another roll superseded this one." >&2
        [ -z "${GITHUB_ACTIONS:-}" ] \
          || echo "::error title=ECS rollout rolled back::$SERVICE is not on $expected_td; it runs $primary_td. ${expected_reason:-}" >&2
        print_rollout_diagnostics "$service_json" "$expected_td"
        return 1
      fi
      echo "✖ rollout did not stabilize within ${budget}s (rolloutState=${rollout:-unknown} running=${running:-?} desired=${desired:-?} pending=${pending:-?})" >&2
      print_rollout_diagnostics "$service_json" "$expected_td"
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

# ── API process role (KORTIX_PROCESS_ROLE) ───────────────────────────────────
# The scheduled jobs run on the worker service (<prefix>-worker). An API task
# runs them too unless its environment says KORTIX_PROCESS_ROLE=web. `web` is
# safe only while a worker on the SAME image is up: a wrong `all` costs CPU on
# one API task, a wrong `web` stops every scheduled job.
#
# decide_api_process_role <worker describe-services JSON>
#                         <worker PRIMARY describe-task-definition JSON>
#                         <worker describe-tasks JSON> <image>
# Prints "<role><TAB><reason>". `web` only when every condition holds; else
# `all` and the first condition that failed. Pure: it reads only its arguments,
# and empty or malformed JSON counts as unknown, which is `all`.
#
# The PRIMARY revision must carry KORTIX_WORKER_ENV_FROM, which only a
# `--service worker` roll sets. Terraform's first revision lacks it: it runs
# with Terraform's environment, without the deploy overrides, and in prod it
# runs the release image (var.api_image). A failed first roll that the circuit
# breaker rolls back to it must not turn the API to `web`.
decide_api_process_role() {
  local services="${1:-}" task_definition="${2:-}" tasks="${3:-}" image="${4:-}"
  jq -rn --arg services "$services" --arg definition "$task_definition" \
    --arg tasks "$tasks" --arg image "$image" '
    def parsed: try fromjson catch null;
    def object: if type == "object" then . else {} end;
    def list: if type == "array" then . else [] end;
    def verdict($role; $reason): [$role, ($reason | gsub("[\t\n]"; " "))] | @tsv;
    ((($services | parsed) | object | .services) | list | .[0] | if type == "object" then . else null end) as $svc
    | if $image == "" then verdict("all"; "no image to compare the worker against")
      elif $svc == null then verdict("all"; "the worker service does not exist")
      elif ($svc.status // "") != "ACTIVE" then
        verdict("all"; "the worker service is \($svc.status // "unknown"), not ACTIVE")
      else
        ([($svc.deployments | list)[] | objects | select(.status == "PRIMARY")][0]) as $primary
        | if $primary == null then verdict("all"; "the worker service has no PRIMARY deployment")
          elif ($primary.rolloutState // "") != "COMPLETED" then
            verdict("all"; "the worker PRIMARY deployment is \($primary.rolloutState // "UNKNOWN"), not COMPLETED")
          else
            ($primary.taskDefinition // "") as $primary_td
            | (($definition | parsed) | object
               | if has("taskDefinition") then (.taskDefinition | object) else . end) as $revision
            | ([($revision.containerDefinitions | list)[] | objects | select(.name == "worker")][0] // {}) as $worker
            | ($worker.image // "") as $worker_image
            | ([($worker.environment | list)[] | objects | select(.name == "KORTIX_WORKER_ENV_FROM") | .value][0] // "") as $env_from
            | if ($revision.taskDefinitionArn // "") != $primary_td then
                verdict("all"; "the worker PRIMARY task definition \($primary_td) could not be read")
              elif ($env_from | type) != "string" or $env_from == "" then
                verdict("all"; "the worker runs a revision ecs-deploy.sh did not register (\($primary_td) has no KORTIX_WORKER_ENV_FROM)")
              elif $worker_image != $image then
                verdict("all"; "the worker PRIMARY task definition \($primary_td) runs \(if $worker_image == "" then "no worker container" else $worker_image end), not \($image)")
              else
                [((($tasks | parsed) | object | .tasks) | list)[] | objects
                 | select(.taskDefinitionArn == $primary_td and (.desiredStatus // "") == "RUNNING")] as $wanted
                | [$wanted[] | select(.lastStatus == "RUNNING" and .healthStatus == "HEALTHY")] as $healthy
                | if ($healthy | length) == 0 then
                    verdict("all"; "no worker task of \($primary_td) is RUNNING and HEALTHY (lastStatus/healthStatus: \([$wanted[] | "\(.lastStatus // "?")/\(.healthStatus // "?")"] | if length == 0 then "no task" else join(", ") end))")
                  else
                    verdict("web"; "the worker runs \($image) on \($primary_td) with \($healthy | length) HEALTHY task(s)")
                  end
              end
          end
      end'
}

# Reads the worker service, its PRIMARY task definition and its tasks, then
# sets PROCESS_ROLE and PROCESS_ROLE_REASON through decide_api_process_role.
# Every read soft-fails to "", which decides `all`.
resolve_api_process_role() {
  local image="$1" worker_service="${SERVICE_PREFIX}-worker"
  local services="" primary_td="" definition="" task_arns="" tasks="" arn decision tab=$'\t'
  local -a arns=()

  services="$(aws ecs describe-services --region "$REGION" --cluster "$SERVICE_PREFIX" \
    --services "$worker_service" --output json 2>/dev/null || true)"
  primary_td="$(printf '%s' "$services" | jq -r '
    [(.services[0].deployments // [])[] | select(.status == "PRIMARY") | .taskDefinition][0] // empty' \
    2>/dev/null || true)"
  if [ -n "$primary_td" ]; then
    definition="$(aws ecs describe-task-definition --region "$REGION" \
      --task-definition "$primary_td" --query 'taskDefinition' --output json 2>/dev/null || true)"
    task_arns="$(aws ecs list-tasks --region "$REGION" --cluster "$SERVICE_PREFIX" \
      --service-name "$worker_service" --desired-status RUNNING \
      --query 'taskArns' --output json 2>/dev/null || true)"
    while IFS= read -r arn; do
      [ -n "$arn" ] || continue
      arns+=("$arn")
    done < <(printf '%s' "$task_arns" \
      | jq -r '(if type == "object" then (.taskArns // []) else . end)[]? | select(type == "string")' \
        2>/dev/null || true)
    if [ "${#arns[@]}" -gt 0 ]; then
      tasks="$(aws ecs describe-tasks --region "$REGION" --cluster "$SERVICE_PREFIX" \
        --tasks "${arns[@]}" --output json 2>/dev/null || true)"
    fi
  fi

  decision="$(decide_api_process_role "$services" "$definition" "$tasks" "$image" 2>/dev/null || true)"
  [ -n "$decision" ] || decision="all${tab}the worker role decision could not be computed"
  PROCESS_ROLE="${decision%%"$tab"*}"
  PROCESS_ROLE_REASON="${decision#*"$tab"}"
}

# After an API rollout that ends with KORTIX_PROCESS_ROLE=all, stop the worker:
# an older worker must not keep the leader lease and run old job code after the
# API moved on, and the prod database budget does not hold an all-mode API
# fleet in its rolling overlap plus a worker. Call it only after the API
# rollout completed: until then the old worker may be the only lease-eligible
# process. Soft-fails: the API is already rolled, so a failure is an ::error
# annotation, not a failed deploy.
scale_worker_to_zero() {
  local reason="$1" worker_service="${SERVICE_PREFIX}-worker" state status desired
  state="$(aws ecs describe-services --region "$REGION" --cluster "$SERVICE_PREFIX" \
    --services "$worker_service" --query 'services[0].[status,desiredCount]' \
    --output text 2>/dev/null || true)"
  read -r status desired <<<"${state:-}" || true
  if [ "${status:-}" != "ACTIVE" ]; then
    echo "▶ worker $worker_service is not ACTIVE (got '${status:-none}'): nothing to scale down"
    return 0
  fi
  if [ "${desired:-0}" = "0" ]; then
    echo "▶ worker $worker_service already has desired count 0"
    return 0
  fi
  if aws ecs update-service --region "$REGION" --cluster "$SERVICE_PREFIX" \
    --service "$worker_service" --desired-count 0 >/dev/null; then
    echo "✔ worker $worker_service desired count $desired → 0"
    echo "::warning title=Worker scaled to 0::${reason}; scheduled jobs run on the API tasks until the next successful worker roll" >&2
  else
    echo "::error title=Worker scale-down::could not scale $worker_service to 0 after the API rolled with KORTIX_PROCESS_ROLE=all; an older worker can still hold the leader lease. Run: aws ecs update-service --region $REGION --cluster $SERVICE_PREFIX --service $worker_service --desired-count 0" >&2
  fi
}

# Allow sourcing for tests: `KORTIX_ECS_DEPLOY_LIB=1 source ecs-deploy.sh`.
if [ "${KORTIX_ECS_DEPLOY_LIB:-}" = "1" ]; then
  # shellcheck disable=SC2317 # `exit` is the non-sourced fallback for `return`
  return 0 2>/dev/null || exit 0
fi

ENV="${1:?env required: dev-use2|staging-euw2|prod}"
IMAGE="${2:?image required, e.g. kortix/kortix-api:dev-481dc551}"
shift 2

SVC_KIND="api"
WAIT=1
DRY_RUN=0
DATABASE_MIGRATED=0
VERSION_OVERRIDE=""
WAIT_FOR="stable"
PROCESS_ROLE_MODE="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --service) SVC_KIND="$2"; shift 2 ;;
    --process-role) PROCESS_ROLE_MODE="${2:-}"; shift 2 || shift ;;
    --version) VERSION_OVERRIDE="$2"; shift 2 ;;
    --database-migrated) DATABASE_MIGRATED=1; shift ;;
    --no-wait) WAIT=0; shift ;;
    --wait-for) WAIT_FOR="${2:-}"; shift 2 || shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$WAIT_FOR" in
  serving|stable) ;;
  *) echo "--wait-for must be serving or stable (got: '${WAIT_FOR}')" >&2; exit 2 ;;
esac
# `web` is never accepted from the command line: it is safe only after the
# checks in decide_api_process_role.
case "$PROCESS_ROLE_MODE" in
  auto|all) ;;
  *) echo "--process-role must be auto or all (got: '${PROCESS_ROLE_MODE}')" >&2; exit 2 ;;
esac
if [ "$PROCESS_ROLE_MODE" != "auto" ] && [ "$SVC_KIND" != "api" ]; then
  echo "--process-role applies to --service api only (got --service $SVC_KIND)" >&2
  exit 2
fi

[ -n "$VERSION_OVERRIDE" ] || VERSION_OVERRIDE="$(derive_version_from_image "$IMAGE")"

# ── per-environment coordinates ──────────────────────────────────────────────
configure_env_coordinates "$ENV" || exit 2

if [ "$DRY_RUN" != "1" ] \
  && [ "$ENV" = "prod" ] \
  && [ "$DATABASE_MIGRATED" != "1" ]; then
  echo "refusing live $ENV rollout without --database-migrated; apply and verify all database migrations first" >&2
  exit 2
fi

# Each service lives in its own cluster (the ecs-api module names cluster==service),
# except the worker, which shares the API's cluster.
configure_service_coordinates "$SVC_KIND"

# The new worker waits for the leader lease until the old one stops, so the
# worker roll is done only when the old task is gone: `stable`, always.
if [ "$SVC_KIND" = "worker" ] && [ "$WAIT_FOR" != "stable" ]; then
  echo "▶ --wait-for $WAIT_FOR ignored: the worker always waits stable (the old task hands the leader lease over when it stops)"
  WAIT_FOR="stable"
fi

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

# ── API process role: who runs the scheduled jobs ────────────────────────────
PROCESS_ROLE=""
PROCESS_ROLE_REASON=""
if [ "$SVC_KIND" = "api" ]; then
  if [ "$PROCESS_ROLE_MODE" = "all" ]; then
    PROCESS_ROLE="all"
    PROCESS_ROLE_REASON="forced by --process-role all"
  else
    resolve_api_process_role "$IMAGE"
  fi
  echo "▶ KORTIX_PROCESS_ROLE=$PROCESS_ROLE ($PROCESS_ROLE_REASON)"
  # A dry run renders only (Deploy Dev's release gate runs one before the
  # worker rolls), so it annotates nothing.
  if [ "$PROCESS_ROLE" = "all" ] && [ "$DRY_RUN" != "1" ]; then
    echo "::warning title=API process role::KORTIX_PROCESS_ROLE=all: ${PROCESS_ROLE_REASON}. The API tasks run the scheduled jobs." >&2
  fi
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

# The environment is the running revision's, except for the worker: it runs
# the API's jobs, so it takes the API service's running environment. Keys such
# as the snapshot bucket exist only there (deploy overrides), never in
# Terraform, which created the worker's first revision.
ENV_SOURCE_TD_JSON="$CURRENT_TD_JSON"
ENV_SOURCE_CONTAINER="$CONTAINER"
if [ "$SVC_KIND" = "worker" ]; then
  API_TD="$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
    --services "$SERVICE_PREFIX" --query 'services[0].taskDefinition' --output text)"
  [ -n "$API_TD" ] && [ "$API_TD" != "None" ] \
    || { echo "API service $SERVICE_PREFIX has no task-def; the worker copies its environment from it" >&2; exit 1; }
  ENV_SOURCE_TD_JSON="$(aws ecs describe-task-definition --region "$REGION" \
    --task-definition "$API_TD" --query 'taskDefinition' --output json)"
  ENV_SOURCE_CONTAINER="api"
  printf '%s' "$ENV_SOURCE_TD_JSON" | jq -e 'any(.containerDefinitions[]?; .name == "api")' >/dev/null \
    || { echo "$API_TD has no container 'api'; the worker copies its environment from it" >&2; exit 1; }
  echo "▶ environment copied from $API_TD (container api)"
fi

ENVIRONMENT_OVERRIDES_JSON="${KORTIX_ECS_ENV_OVERRIDES:-}"
[ -n "$ENVIRONMENT_OVERRIDES_JSON" ] || ENVIRONMENT_OVERRIDES_JSON='{}'
if [ "$SVC_KIND" = "api" ] || [ "$SVC_KIND" = "worker" ]; then
  GATEWAY_TARGET="$(gateway_target_for_env "$ENV")"
  ENVIRONMENT_OVERRIDES_JSON="$(printf '%s' "$ENVIRONMENT_OVERRIDES_JSON" | jq -c \
    --arg target "$GATEWAY_TARGET" '. + {LLM_GATEWAY_PROXY_TARGET: $target}')"
fi
CURRENT_ENVIRONMENT_JSON="$(printf '%s' "$ENV_SOURCE_TD_JSON" | jq -c --arg c "$ENV_SOURCE_CONTAINER" \
  '[.containerDefinitions[] | select(.name == $c) | (.environment // [])][0] // []')"
MERGED_ENVIRONMENT_JSON="$(merge_environment_overrides "$CURRENT_ENVIRONMENT_JSON" "$ENVIRONMENT_OVERRIDES_JSON")"
# The decided role wins over the running revision and over any override. The
# worker never carries it.
case "$SVC_KIND" in
  api)
    MERGED_ENVIRONMENT_JSON="$(merge_environment_overrides "$MERGED_ENVIRONMENT_JSON" \
      "$(jq -cn --arg role "$PROCESS_ROLE" '{KORTIX_PROCESS_ROLE: $role}')")"
    ;;
  worker)
    # KORTIX_WORKER_ENV_FROM marks a revision this script registered, with the
    # API's environment. decide_api_process_role requires it before the API
    # may go `web`; Terraform's first revision never has it.
    MERGED_ENVIRONMENT_JSON="$(printf '%s' "$MERGED_ENVIRONMENT_JSON" | jq -c 'map(select(.name != "KORTIX_PROCESS_ROLE"))')"
    MERGED_ENVIRONMENT_JSON="$(merge_environment_overrides "$MERGED_ENVIRONMENT_JSON" \
      "$(jq -cn --arg from "$API_TD" '{KORTIX_WORKER_ENV_FROM: $from}')")"
    ;;
esac
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
  if [ -n "${ECS_DEPLOY_RENDERED_ENV_FILE:-}" ]; then
    (umask 077 && printf '%s' "$NEW_TD_JSON" | jq -c --arg c "$CONTAINER" \
      '[.containerDefinitions[] | select(.name == $c) | .environment][0] // []' \
      >"$ECS_DEPLOY_RENDERED_ENV_FILE")
  fi
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
#
# Except the worker: Terraform creates it at 0 (it applies before the
# migrations), and an API roll that fell back to KORTIX_PROCESS_ROLE=all scales
# it to 0. Its own roll is what starts it, so it sets 1, in a SECOND call. One
# call with the new revision and --desired-count 1 on a service at 0 tasks made
# ECS start a task of the CURRENT revision first, then roll it (dev,
# 2026-11-01: a task of Terraform's first revision ran with Terraform's
# environment for minutes). The first call points the service at the new
# revision and starts nothing while the count is 0; the second scales the new
# revision. With the worker already at 1, the first call rolls as usual and the
# second changes nothing.
if [ "$SVC_KIND" = "worker" ]; then
  worker_desired_before="$(describe_service_json | jq -r '.services[0].desiredCount // 1' 2>/dev/null || echo 1)"
  aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
    --task-definition "$NEW_TD" --force-new-deployment >/dev/null
  # From 0 tasks, wait until the earlier deployments are gone before raising
  # the count. Two calls one second apart still let ECS start a task of the
  # earlier revision while that deployment existed (prod, 2026-11-01: a task of
  # Terraform's first revision ran for a minute). With nothing running, the
  # new deployment completes at once and the old ones leave within seconds.
  if [ "$worker_desired_before" = "0" ]; then
    waited=0
    while [ "$(describe_service_json | jq -r '(.services[0].deployments // []) | length' 2>/dev/null || echo 0)" -gt 1 ] \
      && [ "$waited" -lt "$ECS_WORKER_SWITCH_WAIT_SECONDS" ]; do
      sleep "$ECS_STABILIZE_POLL_SECONDS"
      waited=$(( waited + ECS_STABILIZE_POLL_SECONDS ))
    done
    if [ "$(describe_service_json | jq -r '(.services[0].deployments // []) | length' 2>/dev/null || echo 0)" -gt 1 ]; then
      echo "::warning title=Worker roll::an earlier worker deployment still exists after ${ECS_WORKER_SWITCH_WAIT_SECONDS}s; raising the count anyway, so ECS may briefly start a task of the earlier revision"
    fi
  fi
  aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
    --desired-count 1 >/dev/null
  echo "✔ update-service issued (new revision, then desired count 1)"
else
  aws ecs update-service --region "$REGION" --cluster "$CLUSTER" --service "$SERVICE" \
    --task-definition "$NEW_TD" --force-new-deployment >/dev/null
  echo "✔ update-service issued (desired count unchanged)"
fi

if [ "$WAIT" = "1" ]; then
  echo "⏳ waiting for the rollout (--wait-for ${WAIT_FOR}, budget ${ECS_STABILIZE_TIMEOUT_SECONDS}s, poll ${ECS_STABILIZE_POLL_SECONDS}s) …"
  wait_for_stable_rollout "$ECS_STABILIZE_TIMEOUT_SECONDS" "$ECS_STABILIZE_POLL_SECONDS" "$WAIT_FOR" "$NEW_TD"
  aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].{running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}' \
    --output table
  # Only here, after the API rollout completed: a failed wait exits above.
  if [ "$SVC_KIND" = "api" ] && [ "$PROCESS_ROLE" = "all" ]; then
    scale_worker_to_zero "the API rolled with KORTIX_PROCESS_ROLE=all (${PROCESS_ROLE_REASON})"
  fi
elif [ "$SVC_KIND" = "api" ] && [ "$PROCESS_ROLE" = "all" ]; then
  echo "::warning title=Worker not scaled to 0::--no-wait: the API rollout was not awaited, so the worker keeps its desired count. Scale it to 0 once the API rollout completes, or redeploy the API without --no-wait." >&2
fi
echo "✅ $ENV/$CONTAINER now on $IMAGE ($NEW_TD)"
