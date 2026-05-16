#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  GATE5_API_CURL_CONFIRM=I_VERIFIED_TARGET_API_CURLS \
  GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
  GATE5_API_CURL_USER_TOKEN=... \
  ADMIN_TOKEN=... \
  GATE5_API_CURL_ACCOUNT_ID=... \
  GATE5_API_CURL_PROJECT_ID=... \
  GATE5_API_CURL_SESSION_ID=... \
  GATE5_API_CURL_EXTERNAL_ID=... \
  pnpm --dir tests run test:e2e:gate5:record-api-curl

Reads:
  $GATE5_TARGET_EVIDENCE_DIR/summary.json

Writes:
  $GATE5_TARGET_EVIDENCE_DIR/api-curl-*.json
  $GATE5_TARGET_EVIDENCE_DIR/api-curl-proof.json
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-api-curl] Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[gate5-api-curl] Missing required env var: $name" >&2
    exit 1
  fi
}

curl_json() {
  local name="$1"
  local output="$2"
  local url="$3"
  local token="${4:-}"
  local method="${5:-GET}"
  local tmp="$output.tmp"
  local status
  local headers=(-H "Accept: application/json")

  if [ -n "$token" ]; then
    headers+=(-H "Authorization: Bearer $token")
  fi

  status="$(curl -sS -w '%{http_code}' -X "$method" "${headers[@]}" "$url" -o "$tmp")"
  if [ "$status" != "200" ]; then
    echo "[gate5-api-curl] $name returned HTTP $status from $url" >&2
    if [ -s "$tmp" ]; then
      sed -n '1,20p' "$tmp" >&2
    fi
    rm -f "$tmp"
    exit 1
  fi

  mv "$tmp" "$output"
  jq -e type "$output" >/dev/null
}

curl_text() {
  local name="$1"
  local output="$2"
  local headers_output="$3"
  local url="$4"
  local token="${5:-}"
  local method="${6:-GET}"
  local tmp="$output.tmp"
  local headers_tmp="$headers_output.tmp"
  local status
  local headers=(-H "Accept: text/html,*/*")

  if [ -n "$token" ]; then
    headers+=(-H "Authorization: Bearer $token")
  fi

  status="$(curl -sS -w '%{http_code}' -X "$method" -D "$headers_tmp" "${headers[@]}" "$url" -o "$tmp")"
  if [ "$status" != "200" ]; then
    echo "[gate5-api-curl] $name returned HTTP $status from $url" >&2
    if [ -s "$tmp" ]; then
      sed -n '1,20p' "$tmp" >&2
    fi
    rm -f "$tmp" "$headers_tmp"
    exit 1
  fi

  mv "$tmp" "$output"
  mv "$headers_tmp" "$headers_output"
}

require_cmd curl
require_cmd jq

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${GATE5_API_CURL_CONFIRM:-}" != "I_VERIFIED_TARGET_API_CURLS" ]; then
  echo "[gate5-api-curl] Refusing to record without GATE5_API_CURL_CONFIRM=I_VERIFIED_TARGET_API_CURLS" >&2
  exit 1
fi

require_env GATE5_TARGET_EVIDENCE_DIR
require_env GATE5_API_CURL_USER_TOKEN
require_env ADMIN_TOKEN
require_env GATE5_API_CURL_ACCOUNT_ID
require_env GATE5_API_CURL_PROJECT_ID
require_env GATE5_API_CURL_SESSION_ID
require_env GATE5_API_CURL_EXTERNAL_ID

summary_file="$GATE5_TARGET_EVIDENCE_DIR/summary.json"
if [ ! -s "$summary_file" ]; then
  echo "[gate5-api-curl] Missing target summary: $summary_file" >&2
  exit 1
fi

jq -e '
  .status == "passed"
  and .target_rehearsal_runner == "tests/e2e/scripts/run-gate5-target-rehearsal.sh"
  and .evidence_contract_version == 1
  and .destructive_tests_run == true
' "$summary_file" >/dev/null || {
  echo "[gate5-api-curl] Refusing to record proof for a preflight, incomplete, or stale-contract target rehearsal" >&2
  exit 1
}

api_url="${E2E_API_URL:-$(jq -r '.api_url // ""' "$summary_file")}"
api_url="${api_url%/}"
if [ -z "$api_url" ] || [ "$api_url" = "null" ]; then
  echo "[gate5-api-curl] E2E_API_URL or summary.api_url is required" >&2
  exit 1
fi

account_id="$GATE5_API_CURL_ACCOUNT_ID"
project_id="$GATE5_API_CURL_PROJECT_ID"
session_id="$GATE5_API_CURL_SESSION_ID"
external_id="$GATE5_API_CURL_EXTERNAL_ID"
timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"

health_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-health.json"
accounts_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-accounts.json"
account_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-account.json"
account_members_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-account-members.json"
account_invites_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-account-invites.json"
projects_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-projects.json"
project_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-project.json"
project_detail_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-project-detail.json"
project_files_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-project-files.json"
project_file_content_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-project-file-content.json"
sessions_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-project-sessions.json"
session_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-project-session.json"
sandbox_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-session-sandbox.json"
proxy_health_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-proxy-health.json"
proxy_app_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-proxy-app.html"
proxy_app_headers_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-proxy-app.headers"
proxy_opencode_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-proxy-opencode.json"
proxy_agents_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-proxy-opencode-agents.json"
proxy_refresh_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-proxy-refresh.json"
ops_file="$GATE5_TARGET_EVIDENCE_DIR/api-curl-ops-overview.json"

curl_json health "$health_file" "$api_url/health"
jq -e '.status == "ok"' "$health_file" >/dev/null

curl_json accounts "$accounts_file" "$api_url/accounts" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg account_id "$account_id" '
  type == "array" and any(.[]; .account_id == $account_id)
' "$accounts_file" >/dev/null

curl_json account "$account_file" "$api_url/accounts/$account_id" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg account_id "$account_id" '
  .account_id == $account_id
  and (.name | type == "string" and length > 0)
  and (.member_count | type == "number" and . >= 1)
  and (.project_count | type == "number" and . >= 1)
  and (.role == "owner" or .role == "admin" or .role == "member")
' "$account_file" >/dev/null

curl_json account_members "$account_members_file" "$api_url/accounts/$account_id/members" "$GATE5_API_CURL_USER_TOKEN"
jq -e '
  type == "array"
  and length >= 1
  and all(.[]; (.user_id | type == "string" and length > 0) and (.account_role == "owner" or .account_role == "admin" or .account_role == "member"))
' "$account_members_file" >/dev/null

curl_json account_invites "$account_invites_file" "$api_url/accounts/$account_id/invites" "$GATE5_API_CURL_USER_TOKEN"
jq -e 'type == "array"' "$account_invites_file" >/dev/null

curl_json projects "$projects_file" "$api_url/projects?account_id=$account_id" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg project_id "$project_id" '
  type == "array" and any(.[]; .project_id == $project_id)
' "$projects_file" >/dev/null

curl_json project "$project_file" "$api_url/projects/$project_id" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg account_id "$account_id" --arg project_id "$project_id" '
  .project_id == $project_id
  and .account_id == $account_id
  and (.repo_url | type == "string" and length > 0)
  and (.default_branch | type == "string" and length > 0)
  and (.manifest_path | type == "string" and length > 0)
  and .status == "active"
' "$project_file" >/dev/null

curl_json project_detail "$project_detail_file" "$api_url/projects/$project_id/detail" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg project_id "$project_id" '
  .project.project_id == $project_id
  and (.project.repo_url | type == "string" and length > 0)
  and (.config | type == "object")
  and (.file_count | type == "number" and . >= 1)
  and (.files | type == "array" and any(.[]; ((.path // "") == "kortix.toml") or .name == "kortix.toml"))
' "$project_detail_file" >/dev/null

curl_json project_files "$project_files_file" "$api_url/projects/$project_id/files" "$GATE5_API_CURL_USER_TOKEN"
jq -e '
  type == "array"
  and any(.[]; .type == "file" and (((.path // "") == "README.md") or .name == "README.md"))
  and any(.[]; .type == "file" and (((.path // "") == ".opencode/opencode.jsonc") or .name == "opencode.jsonc"))
' "$project_files_file" >/dev/null

curl_json project_file_content "$project_file_content_file" "$api_url/projects/$project_id/files/content?path=.opencode/opencode.jsonc" "$GATE5_API_CURL_USER_TOKEN"
jq -e '
  .path == ".opencode/opencode.jsonc"
  and (.ref | type == "string" and length > 0)
  and (.content | type == "string" and contains("\"default_agent\""))
' "$project_file_content_file" >/dev/null

curl_json project_sessions "$sessions_file" "$api_url/projects/$project_id/sessions" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg session_id "$session_id" '
  type == "array"
  and any(.[]; .session_id == $session_id and .branch_name == $session_id and .sandbox_provider == "daytona")
' "$sessions_file" >/dev/null

curl_json project_session "$session_file" "$api_url/projects/$project_id/sessions/$session_id" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg account_id "$account_id" --arg project_id "$project_id" --arg session_id "$session_id" '
  .session_id == $session_id
  and .account_id == $account_id
  and .project_id == $project_id
  and .branch_name == $session_id
  and .sandbox_id == $session_id
  and .sandbox_provider == "daytona"
' "$session_file" >/dev/null

curl_json session_sandbox "$sandbox_file" "$api_url/projects/$project_id/sessions/$session_id/sandbox" "$GATE5_API_CURL_USER_TOKEN"
jq -e \
  --arg project_id "$project_id" \
  --arg session_id "$session_id" \
  --arg external_id "$external_id" \
  '
    .project_id == $project_id
    and .session_id == $session_id
    and .sandbox_id == $session_id
    and .provider == "daytona"
    and .external_id == $external_id
    and .external_id != $session_id
    and .status == "active"
  ' "$sandbox_file" >/dev/null

curl_json proxy_health "$proxy_health_file" "$api_url/p/$external_id/8000/kortix/health" "$GATE5_API_CURL_USER_TOKEN"
jq -e --arg session_id "$session_id" '
  .daemon == "ok"
  and .opencode == "ok"
  and (.uptime_s | type == "number")
  and has("opencode_pid")
  and (.repo | type == "string" and length > 0)
  and .branch == $session_id
  and (.commit_sha | type == "string" and length > 0)
  and .auth == "configured"
' "$proxy_health_file" >/dev/null

curl_text proxy_app "$proxy_app_file" "$proxy_app_headers_file" "$api_url/p/$external_id/8000/app" "$GATE5_API_CURL_USER_TOKEN"
grep -qi '^content-type:.*text/html' "$proxy_app_headers_file"
grep -qi '<title>OpenCode</title>' "$proxy_app_file"

curl_json proxy_opencode "$proxy_opencode_file" "$api_url/p/$external_id/8000/file?path=.opencode" "$GATE5_API_CURL_USER_TOKEN"
jq -e '
  type == "array"
  and any(.[]; .type == "directory" and ((.path // "") == ".opencode/agents" or ((.path // "") | endswith("/agents")) or .name == "agents"))
' "$proxy_opencode_file" >/dev/null

curl_json proxy_opencode_agents "$proxy_agents_file" "$api_url/p/$external_id/8000/file?path=.opencode/agents" "$GATE5_API_CURL_USER_TOKEN"
jq -e '
  type == "array"
  and any(.[]; .type == "file" and (((.path // "") | endswith("/default.md")) or .name == "default.md"))
  and any(.[]; .type == "file" and (((.path // "") | endswith("/reviewer.md")) or .name == "reviewer.md"))
' "$proxy_agents_file" >/dev/null

curl_json proxy_refresh "$proxy_refresh_file" "$api_url/p/$external_id/8000/kortix/refresh" "$GATE5_API_CURL_USER_TOKEN" POST
jq -e '
  .ok == true
  and (.repo.before.commit | type == "string" and length > 0)
  and (.repo.after.commit | type == "string" and length > 0)
  and (.opencode | type == "string" and length > 0)
  and has("opencode_pid")
' "$proxy_refresh_file" >/dev/null

curl_json ops_overview "$ops_file" "$api_url/ops/overview" "$ADMIN_TOKEN"
jq -e '.api.status == "ok"' "$ops_file" >/dev/null

jq -n \
  --arg generated_at "$timestamp" \
  --arg api_url "$api_url" \
  --arg account_id "$account_id" \
  --arg project_id "$project_id" \
  --arg session_id "$session_id" \
  --arg external_id "$external_id" \
  '{
    status: "passed",
    generated_at: $generated_at,
    evidence_contract_version: 1,
    api_url: $api_url,
    target_ids: {
      account_id: $account_id,
      project_id: $project_id,
      session_id: $session_id,
      external_id: $external_id
    },
    endpoints: [
      { name: "health", method: "GET", path: "/health", status: 200, artifact: "api-curl-health.json" },
      { name: "accounts", method: "GET", path: "/accounts", status: 200, artifact: "api-curl-accounts.json" },
      { name: "account", method: "GET", path: "/accounts/<account_id>", status: 200, artifact: "api-curl-account.json" },
      { name: "account_members", method: "GET", path: "/accounts/<account_id>/members", status: 200, artifact: "api-curl-account-members.json" },
      { name: "account_invites", method: "GET", path: "/accounts/<account_id>/invites", status: 200, artifact: "api-curl-account-invites.json" },
      { name: "projects", method: "GET", path: "/projects?account_id=<account_id>", status: 200, artifact: "api-curl-projects.json" },
      { name: "project", method: "GET", path: "/projects/<project_id>", status: 200, artifact: "api-curl-project.json" },
      { name: "project_detail", method: "GET", path: "/projects/<project_id>/detail", status: 200, artifact: "api-curl-project-detail.json" },
      { name: "project_files", method: "GET", path: "/projects/<project_id>/files", status: 200, artifact: "api-curl-project-files.json" },
      { name: "project_file_content", method: "GET", path: "/projects/<project_id>/files/content?path=.opencode/opencode.jsonc", status: 200, artifact: "api-curl-project-file-content.json" },
      { name: "project_sessions", method: "GET", path: "/projects/<project_id>/sessions", status: 200, artifact: "api-curl-project-sessions.json" },
      { name: "project_session", method: "GET", path: "/projects/<project_id>/sessions/<session_id>", status: 200, artifact: "api-curl-project-session.json" },
      { name: "session_sandbox", method: "GET", path: "/projects/<project_id>/sessions/<session_id>/sandbox", status: 200, artifact: "api-curl-session-sandbox.json" },
      { name: "proxy_health", method: "GET", path: "/p/<external_id>/8000/kortix/health", status: 200, artifact: "api-curl-proxy-health.json" },
      { name: "proxy_app", method: "GET", path: "/p/<external_id>/8000/app", status: 200, artifact: "api-curl-proxy-app.html", headers_artifact: "api-curl-proxy-app.headers" },
      { name: "proxy_opencode", method: "GET", path: "/p/<external_id>/8000/file?path=.opencode", status: 200, artifact: "api-curl-proxy-opencode.json" },
      { name: "proxy_opencode_agents", method: "GET", path: "/p/<external_id>/8000/file?path=.opencode/agents", status: 200, artifact: "api-curl-proxy-opencode-agents.json" },
      { name: "proxy_refresh", method: "POST", path: "/p/<external_id>/8000/kortix/refresh", status: 200, artifact: "api-curl-proxy-refresh.json" },
      { name: "ops_overview", method: "GET", path: "/ops/overview", status: 200, artifact: "api-curl-ops-overview.json" }
    ]
  }' >"$GATE5_TARGET_EVIDENCE_DIR/api-curl-proof.json"

echo "[gate5-api-curl] API curl proof written to $GATE5_TARGET_EVIDENCE_DIR/api-curl-proof.json"
