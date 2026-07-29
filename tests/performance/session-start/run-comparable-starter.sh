#!/usr/bin/env bash
#
# Create one disposable default starter project, benchmark Daytona and Platinum
# against that same repository, and archive the raw result.
#
# Required:
#   BENCH_API         API origin without /v1
#   BENCH_TOKEN       PAT or JWT for BENCH_API
#   BENCH_DB_URL      database URL for BENCH_API
#   BENCH_ACCOUNT_ID  account that owns the disposable project
#
# Optional:
#   BENCH_ENVIRONMENT result label (default: custom)
#   BENCH_ROUNDS      sessions per provider (default: 5)
#   BENCH_TIMEOUT_S   per-session timeout (default: 180)
#   BENCH_OUT         raw JSON output path
#
# The script deletes the project on exit. The API keeps archived project and
# session rows for audit. The token and database URL never enter the result.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

: "${BENCH_API:?BENCH_API is required}"
: "${BENCH_TOKEN:?BENCH_TOKEN is required}"
: "${BENCH_DB_URL:?BENCH_DB_URL is required}"
: "${BENCH_ACCOUNT_ID:?BENCH_ACCOUNT_ID is required}"

BENCH_API="${BENCH_API%/}"
BENCH_ENVIRONMENT="${BENCH_ENVIRONMENT:-custom}"
BENCH_ROUNDS="${BENCH_ROUNDS:-5}"
BENCH_TIMEOUT_S="${BENCH_TIMEOUT_S:-180}"
BENCH_OUT="${BENCH_OUT:-$SCRIPT_DIR/results/$(date -u +%F)/${BENCH_ENVIRONMENT}-starter.json}"

project_id=""
cleanup() {
  if [ -z "$project_id" ]; then
    return
  fi
  status="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      -X DELETE \
      -H "Authorization: Bearer $BENCH_TOKEN" \
      "$BENCH_API/v1/projects/$project_id" ||
      true
  )"
  printf 'project cleanup: HTTP %s\n' "$status" >&2
}
trap cleanup EXIT

project_name="boot-benchmark-starter-$(date -u +%s)"
project_response="$(
  curl -fsS \
    -X POST \
    -H "Authorization: Bearer $BENCH_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$(
      jq -cn \
        --arg account_id "$BENCH_ACCOUNT_ID" \
        --arg name "$project_name" \
        '{account_id:$account_id,name:$name,seed_starter:true}'
    )" \
    "$BENCH_API/v1/projects/provision"
)"
project_id="$(jq -r '.project_id // .id // empty' <<<"$project_response")"
if [ -z "$project_id" ]; then
  printf 'project provision returned no project_id\n' >&2
  exit 1
fi

project_json="$(
  curl -fsS \
    -H "Authorization: Bearer $BENCH_TOKEN" \
    "$BENCH_API/v1/projects/$project_id"
)"
repo_url="$(jq -r '.repo_url // .repoUrl // empty' <<<"$project_json")"
base_sha=""
if [ -n "$repo_url" ]; then
  base_sha="$(git ls-remote "$repo_url" refs/heads/main 2>/dev/null | awk 'NR == 1 { print $1 }')"
fi

targets="$(
  jq -cn \
    --arg project_id "$project_id" \
    --arg repo_url "$repo_url" \
    --arg base_sha "$base_sha" \
    '[
      {
        label:"daytona-starter",
        projectId:$project_id,
        provider:"daytona",
        repoUrl:$repo_url,
        baseSha:$base_sha
      },
      {
        label:"platinum-starter",
        projectId:$project_id,
        provider:"platinum",
        repoUrl:$repo_url,
        baseSha:$base_sha
      }
    ]'
)"

mkdir -p "$(dirname "$BENCH_OUT")"
printf 'environment=%s project=%s repo=%s base_sha=%s\n' \
  "$BENCH_ENVIRONMENT" "$project_id" "$repo_url" "${base_sha:-unknown}" >&2

BENCH_TOKEN="$BENCH_TOKEN" \
BENCH_DB_URL="$BENCH_DB_URL" \
BENCH_API="$BENCH_API" \
BENCH_TARGETS="$targets" \
BENCH_ROUNDS="$BENCH_ROUNDS" \
BENCH_TIMEOUT_S="$BENCH_TIMEOUT_S" \
BENCH_OUT="$BENCH_OUT" \
  bun run "$REPO_ROOT/apps/api/scripts/bench-boot-attribution.ts"
