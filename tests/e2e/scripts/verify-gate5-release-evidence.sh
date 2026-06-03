#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

required_drills=(
  provider-failure
  stripe-failure
  db-migration-rollback
  legacy-migration-rollback
  sandbox-image-rollback
  api-deploy-rollback
)

required_local_checks=(
  api_typecheck
  web_typecheck
  api_tests
  api_billing_tests
  api_accounts_contract_tests
  api_projects_contract_tests
  api_project_session_contract_tests
  api_project_triggers_contract_tests
  api_rate_limit_tests
  api_proxy_contract_tests
  api_audit_tests
  api_github_app_tests
  api_create_repo_starter_tests
  legacy_migration_tooling
  sandbox_daemon_auth
  sandbox_image_build
  api_image_build
  gate5_scripts_syntax
  gate5_release_verifier_fixture_tests
  web_auth_return_url_tests
  v1_playwright_spec_guards
  v1_legacy_script_guards
  v1_tree_cleanup_guards
  v1_legacy_web_route_guards
  git_diff_check
)

required_self_hosted_titles=(
  "API install-status endpoint works"
  "owner can authenticate via Supabase API"
  "browser login flow reaches wizard"
  "API and web enforce account roles plus project-scoped access"
  "admin overview and operations dashboard use the supported ops API cleanly"
  "E2E-2 and E2E-3: account filtering plus pending invite auto-claim"
  "E2E-1 and E2E-4: GitHub repo project starts a session and reaches daemon health"
  "E2E-5: local_docker provider starts the same sandbox image and reaches health"
  "E2E-6: new session opens the project chat route without legacy redirects"
  "E2E-7: signed webhook trigger fires a session and rejects bad signatures"
  "§10.6/§10.7 API boundaries and invite concurrency hold"
  "§10.6.C SLO probes meet the configured production budgets"
)

required_target_titles=(
  "API and web enforce account roles plus project-scoped access"
  "admin overview and operations dashboard use the supported ops API cleanly"
  "E2E-2 and E2E-3: account filtering plus pending invite auto-claim"
  "E2E-1 and E2E-4: GitHub repo project starts a session and reaches daemon health"
  "E2E-5: local_docker provider starts the same sandbox image and reaches health"
  "E2E-6: new session opens the project chat route without legacy redirects"
  "E2E-7: signed webhook trigger fires a session and rejects bad signatures"
  "§10.6/§10.7 API boundaries and invite concurrency hold"
  "§10.6.C SLO probes meet the configured production budgets"
)

required_api_curl_endpoints=(
  health
  accounts
  account
  account_members
  account_invites
  projects
  project
  project_detail
  project_files
  project_file_content
  project_sessions
  project_session
  session_sandbox
  proxy_health
  proxy_app
  proxy_opencode
  proxy_opencode_agents
  proxy_refresh
  ops_overview
)

insecure_target_url_seen=0
insecure_evidence_url_seen=0

usage() {
  cat <<'USAGE'
Usage:
  GATE5_LOCAL_EVIDENCE_DIR=test-results/gate5-local-verification/<timestamp> \
  GATE5_SELF_HOSTED_EVIDENCE_DIR=test-results/gate5-self-hosted/<timestamp> \
  GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
  GATE5_DRILLS_EVIDENCE_DIR=test-results/gate5-release/runbook-drills \
  GATE5_RELEASE_MANIFEST=test-results/gate5-release/manifest.json \
  bash tests/e2e/scripts/verify-gate5-release-evidence.sh

Checks:
  - Local verification summary proves required typecheck, API test, sandbox/auth, Docker build, script syntax, v1 legacy-script guards, and diff checks passed.
  - Self-hosted golden report proves auth/account/admin/golden specs ran with local_docker and webhook backpressure enabled.
  - Target rehearsal health, response headers, ops overview, run log, and summary exist.
  - Target API curl proof verifies health, accounts, account detail/members/invites, projects, project detail/files/content, project sessions, single session, session sandbox, proxy health, proxied OpenCode SPA, proxied .opencode starter config, signed daemon refresh, and ops overview.
  - Target Playwright JSON report proves account/project access, admin ops, SPEC 10.5 golden paths, and SPEC 10.6/10.7 boundary/SLO specs ran without failures.
  - Target summary proves the guarded runner used daytona, GitHub App auth, golden paths, managed observability, enforced SLO checks, and zero active legacy gating.
  - Target ops overview proves API/tunnel, sessions, sandboxes/providers, audit, usage, observability, and migration health.
  - Target observability proof files prove the rehearsal probe request_id arrived in the managed log sink and the probe trace_id arrived in the OTLP trace backend.
  - Target SLO proof proves §10.6.C latency budgets were measured and stayed under the SPEC thresholds.
  - Target concurrency proof proves §10.6.B parallel session, invite, sandbox race, and cap behavior.
  - Target negative-space proof proves §10.7 forbidden regressions are absent.
  - Every required production runbook drill has summary.json with status="passed" and evidence entries.
  - A release manifest is written after all checks pass.
  - Non-release fixture modes require GATE5_ALLOW_NON_RELEASE_MANIFEST=1 and never produce release_eligible=true.
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-verify] Missing required command: $1" >&2
    exit 1
  fi
}

require_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "[gate5-verify] Missing required evidence file: $file" >&2
    exit 1
  fi
}

require_json_file() {
  local file="$1"
  require_file "$file"
  if [ ! -s "$file" ]; then
    echo "[gate5-verify] Evidence file is empty: $file" >&2
    exit 1
  fi
  jq -e type "$file" >/dev/null
}

require_evidence_entry() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    if [ "${GATE5_ALLOW_SYNTHETIC_EVIDENCE:-0}" != "1" ] && is_placeholder_or_local_url "$entry"; then
      echo "[gate5-verify] Evidence artifact URL must be a real HTTPS URL, got: $entry" >&2
      echo "[gate5-verify] Use GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 only for local verifier fixture tests; never for release completion." >&2
      exit 1
    fi
    if [[ "$entry" != https://* ]]; then
      insecure_evidence_url_seen=1
    fi
    return 0
  fi
  if [ -f "$entry" ]; then
    return 0
  fi
  if [ -f "$base_dir/$entry" ]; then
    return 0
  fi

  echo "[gate5-verify] Missing evidence artifact: $entry in $base_dir" >&2
  exit 1
}

is_placeholder_or_local_url() {
  local url="$1"
  case "$url" in
    http://localhost*|https://localhost*|http://127.*|https://127.*|http://0.0.0.0*|https://0.0.0.0*|http://[[]::1[]]*|https://[[]::1[]]*)
      return 0
      ;;
    http://10.*|https://10.*|http://192.168.*|https://192.168.*)
      return 0
      ;;
    http://172.16.*|https://172.16.*|http://172.17.*|https://172.17.*|http://172.18.*|https://172.18.*|http://172.19.*|https://172.19.*|http://172.20.*|https://172.20.*|http://172.21.*|https://172.21.*|http://172.22.*|https://172.22.*|http://172.23.*|https://172.23.*|http://172.24.*|https://172.24.*|http://172.25.*|https://172.25.*|http://172.26.*|https://172.26.*|http://172.27.*|https://172.27.*|http://172.28.*|https://172.28.*|http://172.29.*|https://172.29.*|http://172.30.*|https://172.30.*|http://172.31.*|https://172.31.*)
      return 0
      ;;
    http://example.*|https://example.*|http://*.example.*|https://*.example.*|http://*.local*|https://*.local*|http://*.test*|https://*.test*|http://*.invalid*|https://*.invalid*)
      return 0
      ;;
    file://*|"")
      return 0
      ;;
  esac

  if [[ "$url" != https://* && "${GATE5_ALLOW_INSECURE_TARGET_URLS:-0}" != "1" ]]; then
    return 0
  fi

  return 1
}

require_real_target_url() {
  local label="$1"
  local url="$2"

  if [ "${GATE5_ALLOW_SYNTHETIC_EVIDENCE:-0}" = "1" ]; then
    return 0
  fi

  if is_placeholder_or_local_url "$url"; then
    echo "[gate5-verify] $label must be a real production-like HTTPS target URL, got: ${url:-<empty>}" >&2
    echo "[gate5-verify] Use GATE5_ALLOW_SYNTHETIC_EVIDENCE=1 only for local verifier fixture tests; never for release completion." >&2
    exit 1
  fi

  if [[ "$url" != https://* ]]; then
    insecure_target_url_seen=1
  fi
}

resolve_evidence_file() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    echo "[gate5-verify] Expected file evidence artifact, got URL: $entry" >&2
    exit 1
  fi
  if [ -f "$entry" ]; then
    printf '%s\n' "$entry"
    return 0
  fi
  if [ -f "$base_dir/$entry" ]; then
    printf '%s\n' "$base_dir/$entry"
    return 0
  fi

  echo "[gate5-verify] Missing evidence artifact: $entry in $base_dir" >&2
  exit 1
}

api_curl_artifact() {
  local endpoint="$1"
  jq -r --arg endpoint "$endpoint" '
    .endpoints[]
    | select(.name == $endpoint)
    | .artifact
  ' "$api_curl_proof_file" | head -n 1
}

require_playwright_title() {
  local report_file="$1"
  local title="$2"
  if ! jq -e --arg title "$title" '
    [
      .. | objects
      | select((.title | type) == "string" and has("tests"))
      | select((.tests | type) == "array" and (.tests | length) > 0)
      | .title
    ]
    | any(. == $title)
  ' "$report_file" >/dev/null; then
    echo "[gate5-verify] Missing required Playwright test title: $title" >&2
    exit 1
  fi
}

require_playwright_title_ran() {
  local report_file="$1"
  local title="$2"
  require_playwright_title "$report_file" "$title"
  if ! jq -e --arg title "$title" '
    [
      .. | objects
      | select((.title | type) == "string" and .title == $title and has("tests"))
      | .tests[]?
      | select((.expectedStatus // "") != "skipped" and (.status // "") != "skipped")
      | select(any(.results[]?; (.status // "") != "skipped"))
    ]
    | length > 0
  ' "$report_file" >/dev/null; then
    echo "[gate5-verify] Required Playwright test did not run: $title" >&2
    exit 1
  fi
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

require_cmd jq

local_dir="${GATE5_LOCAL_EVIDENCE_DIR:-}"
self_hosted_dir="${GATE5_SELF_HOSTED_EVIDENCE_DIR:-}"
target_dir="${GATE5_TARGET_EVIDENCE_DIR:-}"
drills_dir="${GATE5_DRILLS_EVIDENCE_DIR:-$REPO_ROOT/test-results/gate5-release/runbook-drills}"
manifest_file="${GATE5_RELEASE_MANIFEST:-$REPO_ROOT/test-results/gate5-release/manifest.json}"

if [ -z "$local_dir" ]; then
  echo "[gate5-verify] GATE5_LOCAL_EVIDENCE_DIR is required" >&2
  usage >&2
  exit 1
fi

if [ -z "$target_dir" ]; then
  echo "[gate5-verify] GATE5_TARGET_EVIDENCE_DIR is required" >&2
  usage >&2
  exit 1
fi

if [ -z "$self_hosted_dir" ]; then
  echo "[gate5-verify] GATE5_SELF_HOSTED_EVIDENCE_DIR is required" >&2
  usage >&2
  exit 1
fi

local_summary_file="$local_dir/summary.json"
self_hosted_summary_file="$self_hosted_dir/summary.json"
self_hosted_playwright_file="$self_hosted_dir/playwright-report.json"
self_hosted_log_file="$self_hosted_dir/playwright.log"
health_file="$target_dir/health.json"
headers_file="$target_dir/health.headers"
ops_file="$target_dir/ops-overview.json"
ops_exceptions_file="$target_dir/ops-exceptions.json"
run_log="$target_dir/run.log"
target_summary_file="$target_dir/summary.json"
playwright_report_file="$target_dir/playwright-report.json"
api_curl_proof_file="$target_dir/api-curl-proof.json"
managed_log_proof_file="$target_dir/managed-log-proof.json"
otel_trace_proof_file="$target_dir/otel-trace-proof.json"
slo_proof_file="$target_dir/slo-proof.json"
concurrency_proof_file="$target_dir/concurrency-proof.json"
negative_space_proof_file="$target_dir/negative-space-proof.json"

require_json_file "$local_summary_file"
require_json_file "$self_hosted_summary_file"
require_json_file "$self_hosted_playwright_file"
require_file "$self_hosted_log_file"
require_json_file "$health_file"
require_file "$headers_file"
require_json_file "$ops_file"
require_file "$run_log"
require_json_file "$target_summary_file"
require_json_file "$playwright_report_file"
require_json_file "$api_curl_proof_file"
require_json_file "$managed_log_proof_file"
require_json_file "$otel_trace_proof_file"
require_json_file "$slo_proof_file"
require_json_file "$concurrency_proof_file"
require_json_file "$negative_space_proof_file"

target_api_url="$(jq -r '.api_url // ""' "$target_summary_file")"
target_base_url="$(jq -r '.base_url // ""' "$target_summary_file")"
target_supabase_url="$(jq -r '.supabase_url // ""' "$target_summary_file")"
api_curl_url="$(jq -r '.api_url // ""' "$api_curl_proof_file")"

require_real_target_url "target summary api_url" "$target_api_url"
require_real_target_url "target summary base_url" "$target_base_url"
require_real_target_url "target summary supabase_url" "$target_supabase_url"
require_real_target_url "target API curl api_url" "$api_curl_url"

if [ "${target_api_url%/}" != "${api_curl_url%/}" ]; then
  echo "[gate5-verify] Target summary api_url and API curl proof api_url differ: $target_api_url vs $api_curl_url" >&2
  exit 1
fi

jq -e '.status == "passed"' "$local_summary_file" >/dev/null
for check in "${required_local_checks[@]}"; do
  log_rel="$(jq -r --arg check "$check" '
    .commands[]
    | select(.name == $check and .status == "passed" and .exit_code == 0)
    | .log
  ' "$local_summary_file" | head -n 1)"
  if [ -z "$log_rel" ]; then
    echo "[gate5-verify] Missing passed local verification check: $check" >&2
    exit 1
  fi
  require_file "$local_dir/$log_rel"
done

jq -e '
  .evidence_contract_version == 1
  and .status == "passed"
  and .golden_paths_enabled == "1"
  and .local_docker_golden_enabled == "1"
  and .golden_backpressure_enabled == "1"
  and .provider == "local_docker"
' "$self_hosted_summary_file" >/dev/null
jq -e --argjson min_expected "${#required_self_hosted_titles[@]}" '
  (.errors | length) == 0
  and .stats.unexpected == 0
  and .stats.flaky == 0
  and .stats.expected >= $min_expected
  and .stats.skipped == 0
  and ([.. | objects | select(has("file")) | .file] | any(. == "04-auth-flow.spec.ts"))
  and ([.. | objects | select(has("file")) | .file] | any(. == "08-accounts-project-access.spec.ts"))
  and ([.. | objects | select(has("file")) | .file] | any(. == "09-admin-ops.spec.ts"))
  and ([.. | objects | select(has("file")) | .file] | any(. == "10-production-golden-paths.spec.ts"))
  and ([.. | objects | select(has("file")) | .file] | any(. == "11-production-boundaries.spec.ts"))
' "$self_hosted_playwright_file" >/dev/null
for title in "${required_self_hosted_titles[@]}"; do
  require_playwright_title_ran "$self_hosted_playwright_file" "$title"
done

jq -e '.status == "ok"' "$health_file" >/dev/null
grep -qi '^x-request-id:' "$headers_file"
grep -qi '^traceparent:' "$headers_file"
jq -e '
  .status == "passed"
  and .target_rehearsal_runner == "tests/e2e/scripts/run-gate5-target-rehearsal.sh"
  and .evidence_contract_version == 1
  and (.api_url | type == "string" and length > 0)
  and (.base_url | type == "string" and length > 0)
  and (.supabase_url | type == "string" and length > 0)
  and .provider == "daytona"
  and .github_app_required == "1"
  and .golden_paths_enabled == "1"
  and .managed_observability_required == "1"
  and .no_active_legacy_required == "1"
  and .slos_enforced == "1"
  and .preflight_only == false
  and .destructive_tests_run == true
  and (.observability_probe.request_id | type == "string" and length > 0)
  and (.observability_probe.trace_id | test("^[0-9a-f]{32}$"))
' "$target_summary_file" >/dev/null
jq -e '
  .api.status == "ok"
  and (.api.env | type == "string" and length > 0)
  and (.api.tunnel | type == "object")
  and (.totals.accounts | type == "number")
  and (.totals.projects | type == "number")
  and (.sessions.by_status | type == "object")
  and (.sessions.errored | type == "number")
  and (.sandboxes.by_status | type == "object")
  and (.sandboxes.by_provider | type == "object")
  and ((.sandboxes.by_provider.daytona // 0) >= 1)
  and (.sandboxes.errored | type == "number")
  and (.audit.events_24h | type == "number")
  and (.audit.recent | type == "array")
  and (.usage.last_24h_by_provider | type == "array")
  and (.usage.calls_24h | type == "number")
  and (.usage.cost_usd_24h | type == "number")
  and .observability.trace_headers_enabled == true
  and .observability.structured_request_logs_enabled == true
  and .observability.managed_logs_configured == true
  and .observability.otlp_exporter_configured == true
  and .observability.otlp_request_spans_enabled == true
  and (.migrations.by_status | type == "object")
  and ((.migrations.by_status.failed // 0) == 0)
  and ((.migrations.active_legacy_sandboxes // .totals.active_legacy_sandboxes // 0) == 0)
' "$ops_file" >/dev/null
for endpoint in "${required_api_curl_endpoints[@]}"; do
  jq -e --arg endpoint "$endpoint" '
    .status == "passed"
    and .evidence_contract_version == 1
    and (.api_url | type == "string" and length > 0)
    and (.target_ids.account_id | type == "string" and length > 0)
    and (.target_ids.project_id | type == "string" and length > 0)
    and (.target_ids.session_id | type == "string" and length > 0)
    and (.target_ids.external_id | type == "string" and length > 0)
    and any(.endpoints[]; .name == $endpoint and .status == 200 and (.artifact | type == "string" and length > 0))
  ' "$api_curl_proof_file" >/dev/null || {
    echo "[gate5-verify] Missing passed target API curl endpoint proof: $endpoint" >&2
    exit 1
  }
done
while IFS= read -r entry; do
  require_evidence_entry "$target_dir" "$entry"
done < <(jq -r '.endpoints[].artifact' "$api_curl_proof_file")
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  require_evidence_entry "$target_dir" "$entry"
done < <(jq -r '.endpoints[].headers_artifact? // empty' "$api_curl_proof_file")
api_curl_account_id="$(jq -r '.target_ids.account_id' "$api_curl_proof_file")"
api_curl_project_id="$(jq -r '.target_ids.project_id' "$api_curl_proof_file")"
api_curl_session_id="$(jq -r '.target_ids.session_id' "$api_curl_proof_file")"
api_curl_external_id="$(jq -r '.target_ids.external_id' "$api_curl_proof_file")"
api_health_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact health)")"
api_accounts_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact accounts)")"
api_account_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact account)")"
api_account_members_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact account_members)")"
api_account_invites_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact account_invites)")"
api_projects_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact projects)")"
api_project_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact project)")"
api_project_detail_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact project_detail)")"
api_project_files_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact project_files)")"
api_project_file_content_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact project_file_content)")"
api_sessions_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact project_sessions)")"
api_session_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact project_session)")"
api_sandbox_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact session_sandbox)")"
api_proxy_health_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact proxy_health)")"
api_proxy_app_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact proxy_app)")"
api_proxy_app_headers_file="$(resolve_evidence_file "$target_dir" "$(jq -r '.endpoints[] | select(.name == "proxy_app") | .headers_artifact // ""' "$api_curl_proof_file" | head -n 1)")"
api_proxy_opencode_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact proxy_opencode)")"
api_proxy_agents_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact proxy_opencode_agents)")"
api_proxy_refresh_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact proxy_refresh)")"
api_ops_file="$(resolve_evidence_file "$target_dir" "$(api_curl_artifact ops_overview)")"
require_json_file "$api_health_file"
require_json_file "$api_accounts_file"
require_json_file "$api_account_file"
require_json_file "$api_account_members_file"
require_json_file "$api_account_invites_file"
require_json_file "$api_projects_file"
require_json_file "$api_project_file"
require_json_file "$api_project_detail_file"
require_json_file "$api_project_files_file"
require_json_file "$api_project_file_content_file"
require_json_file "$api_sessions_file"
require_json_file "$api_session_file"
require_json_file "$api_sandbox_file"
require_json_file "$api_proxy_health_file"
require_file "$api_proxy_app_file"
require_file "$api_proxy_app_headers_file"
require_json_file "$api_proxy_opencode_file"
require_json_file "$api_proxy_agents_file"
require_json_file "$api_proxy_refresh_file"
require_json_file "$api_ops_file"
jq -e '.status == "ok"' "$api_health_file" >/dev/null
jq -e --arg account_id "$api_curl_account_id" '
  type == "array" and any(.[]; .account_id == $account_id)
' "$api_accounts_file" >/dev/null
jq -e --arg account_id "$api_curl_account_id" '
  .account_id == $account_id
  and (.name | type == "string" and length > 0)
  and (.member_count | type == "number" and . >= 1)
  and (.project_count | type == "number" and . >= 1)
  and (.role == "owner" or .role == "admin" or .role == "member")
' "$api_account_file" >/dev/null
jq -e '
  type == "array"
  and length >= 1
  and all(.[]; (.user_id | type == "string" and length > 0) and (.account_role == "owner" or .account_role == "admin" or .account_role == "member"))
' "$api_account_members_file" >/dev/null
jq -e 'type == "array"' "$api_account_invites_file" >/dev/null
jq -e --arg project_id "$api_curl_project_id" '
  type == "array" and any(.[]; .project_id == $project_id)
' "$api_projects_file" >/dev/null
jq -e --arg account_id "$api_curl_account_id" --arg project_id "$api_curl_project_id" '
  .project_id == $project_id
  and .account_id == $account_id
  and (.repo_url | type == "string" and length > 0)
  and (.default_branch | type == "string" and length > 0)
  and (.manifest_path | type == "string" and length > 0)
  and .status == "active"
' "$api_project_file" >/dev/null
jq -e --arg project_id "$api_curl_project_id" '
  .project.project_id == $project_id
  and (.project.repo_url | type == "string" and length > 0)
  and (.config | type == "object")
  and (.file_count | type == "number" and . >= 1)
  and (.files | type == "array" and any(.[]; ((.path // "") == "kortix.toml") or .name == "kortix.toml"))
' "$api_project_detail_file" >/dev/null
jq -e '
  type == "array"
  and any(.[]; .type == "file" and (((.path // "") == "README.md") or .name == "README.md"))
  and any(.[]; .type == "file" and (((.path // "") == ".opencode/opencode.jsonc") or .name == "opencode.jsonc"))
' "$api_project_files_file" >/dev/null
jq -e '
  .path == ".opencode/opencode.jsonc"
  and (.ref | type == "string" and length > 0)
  and (.content | type == "string" and contains("\"default_agent\""))
' "$api_project_file_content_file" >/dev/null
jq -e --arg session_id "$api_curl_session_id" '
  type == "array"
  and any(.[]; .session_id == $session_id and .branch_name == $session_id and .sandbox_provider == "daytona")
' "$api_sessions_file" >/dev/null
jq -e --arg account_id "$api_curl_account_id" --arg project_id "$api_curl_project_id" --arg session_id "$api_curl_session_id" '
  .session_id == $session_id
  and .account_id == $account_id
  and .project_id == $project_id
  and .branch_name == $session_id
  and .sandbox_id == $session_id
  and .sandbox_provider == "daytona"
' "$api_session_file" >/dev/null
jq -e \
  --arg project_id "$api_curl_project_id" \
  --arg session_id "$api_curl_session_id" \
  --arg external_id "$api_curl_external_id" \
  '
    .project_id == $project_id
    and .session_id == $session_id
    and .sandbox_id == $session_id
    and .provider == "daytona"
    and .external_id == $external_id
    and .external_id != $session_id
    and .status == "active"
  ' "$api_sandbox_file" >/dev/null
jq -e --arg session_id "$api_curl_session_id" '
  .daemon == "ok"
  and .opencode == "ok"
  and (.uptime_s | type == "number")
  and has("opencode_pid")
  and (.repo | type == "string" and length > 0)
  and .branch == $session_id
  and (.commit_sha | type == "string" and length > 0)
  and .auth == "configured"
' "$api_proxy_health_file" >/dev/null
grep -qi '^content-type:.*text/html' "$api_proxy_app_headers_file"
grep -qi '<title>OpenCode</title>' "$api_proxy_app_file"
jq -e '
  type == "array"
  and any(.[]; .type == "directory" and ((.path // "") == ".opencode/agents" or ((.path // "") | endswith("/agents")) or .name == "agents"))
' "$api_proxy_opencode_file" >/dev/null
jq -e '
  type == "array"
  and any(.[]; .type == "file" and (((.path // "") | endswith("/default.md")) or .name == "default.md"))
  and any(.[]; .type == "file" and (((.path // "") | endswith("/reviewer.md")) or .name == "reviewer.md"))
' "$api_proxy_agents_file" >/dev/null
jq -e '
  .ok == true
  and (.repo.before.commit | type == "string" and length > 0)
  and (.repo.after.commit | type == "string" and length > 0)
  and (.opencode | type == "string" and length > 0)
  and has("opencode_pid")
' "$api_proxy_refresh_file" >/dev/null
jq -e '.api.status == "ok"' "$api_ops_file" >/dev/null
ops_exception_signals_json="$(jq -c '
  [
    (if (.sessions.errored // 0) > 0 then "sessions.errored" else empty end),
    (if (.sandboxes.errored // 0) > 0 then "sandboxes.errored" else empty end)
  ]
' "$ops_file")"
ops_exception_count="$(jq -r 'length' <<<"$ops_exception_signals_json")"
if [ "$ops_exception_count" -gt 0 ]; then
  require_json_file "$ops_exceptions_file"
  jq -e --argjson required_signals "$ops_exception_signals_json" '
    .status == "accepted"
    and .evidence_contract_version == 1
    and (.exceptions | type == "array" and length > 0)
    and all(.exceptions[]; (.signal | type == "string" and length > 0) and (.summary | type == "string" and length > 0) and (.evidence | type == "array" and length > 0))
    and (($required_signals - ([.exceptions[].signal] | unique)) | length == 0)
  ' "$ops_exceptions_file" >/dev/null
  while IFS= read -r entry; do
    require_evidence_entry "$target_dir" "$entry"
  done < <(jq -r '.exceptions[].evidence[]' "$ops_exceptions_file")
fi
grep -q "\[gate5\] Target rehearsal passed" "$run_log"
jq -e '
  (.errors | length) == 0
  and .stats.unexpected == 0
  and .stats.flaky == 0
  and .stats.expected >= 8
  and .stats.skipped <= 1
  and ([.. | objects | select(has("file")) | .file] | any(. == "08-accounts-project-access.spec.ts"))
  and ([.. | objects | select(has("file")) | .file] | any(. == "09-admin-ops.spec.ts"))
  and ([.. | objects | select(has("file")) | .file] | any(. == "10-production-golden-paths.spec.ts"))
  and ([.. | objects | select(has("file")) | .file] | any(. == "11-production-boundaries.spec.ts"))
' "$playwright_report_file" >/dev/null
for title in "${required_target_titles[@]}"; do
  require_playwright_title "$playwright_report_file" "$title"
done
for title in "${required_target_titles[@]}"; do
  if [ "$title" = "E2E-5: local_docker provider starts the same sandbox image and reaches health" ]; then
    continue
  fi
  require_playwright_title_ran "$playwright_report_file" "$title"
done
target_skipped_count="$(jq -r '.stats.skipped // 0' "$playwright_report_file")"
target_skipped_titles_json="$(jq -c '
  [
    .. | objects
    | select((.title | type) == "string" and has("tests"))
    | select(any(.tests[]?; .expectedStatus == "skipped" or .status == "skipped" or any(.results[]?; .status == "skipped")))
    | .title
  ]
' "$playwright_report_file")"
if [ "$target_skipped_count" -eq 0 ]; then
  :
elif [ "$target_skipped_count" -eq 1 ]; then
  jq -e --argjson skipped_titles "$target_skipped_titles_json" '
    .local_docker_golden_enabled == "0"
    and ($skipped_titles | length) == 1
    and ($skipped_titles[0] | contains("E2E-5: local_docker provider"))
  ' "$target_summary_file" >/dev/null || {
    echo "[gate5-verify] The only allowed target skip is the E2E-5 local_docker provider test, and it must be explicit in the Playwright JSON report" >&2
    exit 1
  }
else
  echo "[gate5-verify] Target Playwright report has $target_skipped_count skipped tests; only E2E-5 local_docker may be skipped in target mode" >&2
  exit 1
fi

probe_request_id="$(jq -r '.observability_probe.request_id' "$target_summary_file")"
probe_trace_id="$(jq -r '.observability_probe.trace_id' "$target_summary_file")"
jq -e \
  --arg request_id "$probe_request_id" \
  --arg trace_id "$probe_trace_id" \
  '
    .status == "passed"
    and .evidence_contract_version == 1
    and (.sink | type == "string" and length > 0)
    and (.observed_at | type == "string" and length > 0)
    and (.probe.request_id == $request_id)
    and (.probe.trace_id == $trace_id)
    and (.evidence | type == "array" and length > 0)
  ' "$managed_log_proof_file" >/dev/null
while IFS= read -r entry; do
  require_evidence_entry "$target_dir" "$entry"
done < <(jq -r '.evidence[]' "$managed_log_proof_file")

jq -e \
  --arg trace_id "$probe_trace_id" \
  '
    .status == "passed"
    and .evidence_contract_version == 1
    and (.sink | type == "string" and length > 0)
    and (.observed_at | type == "string" and length > 0)
    and (.probe.trace_id == $trace_id)
    and (.evidence | type == "array" and length > 0)
  ' "$otel_trace_proof_file" >/dev/null
while IFS= read -r entry; do
  require_evidence_entry "$target_dir" "$entry"
done < <(jq -r '.evidence[]' "$otel_trace_proof_file")

jq -e '
  .status == "passed"
  and .evidence_contract_version == 1
  and (.observed_at | type == "string" and length > 0)
  and (.evidence | type == "array" and length > 0)
  and .metrics.session_create_p95_ms.ok == true
  and .metrics.session_create_p95_ms.limit == 800
  and .metrics.sandbox_active_p95_ms.ok == true
  and (.metrics.sandbox_active_p95_ms.provider == "daytona")
  and .metrics.sandbox_active_p95_ms.limit == 45000
  and .metrics.proxy_health_p95_ms.ok == true
  and .metrics.proxy_health_p95_ms.limit == 250
  and .metrics.llm_router_overhead_median_ms.ok == true
  and .metrics.llm_router_overhead_median_ms.limit == 60
  and .metrics.projects_first_paint_p95_ms.ok == true
  and .metrics.projects_first_paint_p95_ms.limit == 1500
' "$slo_proof_file" >/dev/null
while IFS= read -r entry; do
  require_evidence_entry "$target_dir" "$entry"
done < <(jq -r '.evidence[]' "$slo_proof_file")

jq -e '
  .status == "passed"
  and .evidence_contract_version == 1
  and (.observed_at | type == "string" and length > 0)
  and (.evidence | type == "array" and length > 0)
  and .checks.parallel_session_creates.ok == true
  and .checks.parallel_session_creates.requested >= 10
  and .checks.parallel_session_creates.distinct_session_ids == .checks.parallel_session_creates.requested
  and .checks.parallel_session_creates.branches_pushed == .checks.parallel_session_creates.requested
  and .checks.parallel_session_creates.sandbox_rows == .checks.parallel_session_creates.requested
  and .checks.parallel_session_creates.duplicate_key_errors == 0
  and .checks.concurrent_invite_accepts.ok == true
  and .checks.concurrent_invite_accepts.member_rows == 1
  and .checks.concurrent_invite_accepts.idempotent_response_seen == true
  and .checks.sandbox_active_race.ok == true
  and .checks.sandbox_active_race.row_consistent == true
  and .checks.cap_enforcement.ok == true
  and .checks.cap_enforcement.status == 429
  and .checks.cap_enforcement.branch_created == false
  and .checks.cap_enforcement.sandbox_created == false
' "$concurrency_proof_file" >/dev/null
while IFS= read -r entry; do
  require_evidence_entry "$target_dir" "$entry"
done < <(jq -r '.evidence[]' "$concurrency_proof_file")

jq -e '
  .status == "passed"
  and .evidence_contract_version == 1
  and (.observed_at | type == "string" and length > 0)
  and (.evidence | type == "array" and length > 0)
  and .checks.legacy_urls_absent.ok == true
  and .checks.legacy_urls_absent.instances_url_count == 0
  and .checks.legacy_urls_absent.bare_sessions_url_count == 0
  and .checks.legacy_urls_absent.dashboard_redirect_count == 0
  and .checks.legacy_ui_absent.ok == true
  and .checks.legacy_ui_absent.right_rail_count == 0
  and .checks.legacy_ui_absent.justavps_banner_count == 0
  and .checks.provider_whitelist.ok == true
  and .checks.provider_whitelist.justavps_session_status == 400
  and .checks.sandbox_proxy_boundary.ok == true
  and (.checks.sandbox_proxy_boundary.member_proxy_status >= 200 and .checks.sandbox_proxy_boundary.member_proxy_status < 300)
  and .checks.sandbox_proxy_boundary.outsider_proxy_status == 403
  and .checks.removed_user_proxy_revocation.ok == true
  and .checks.removed_user_proxy_revocation.proxy_status == 403
  and .checks.removed_user_proxy_revocation.observed_seconds <= 5
  and .checks.removed_user_proxy_revocation.limit_seconds == 5
  and .checks.legacy_runtime_contamination.ok == true
  and .checks.legacy_runtime_contamination.legacy_sandbox_rows == 0
  and .checks.legacy_runtime_contamination.legacy_platform_project_rows == 0
  and .checks.session_switch_regressions.ok == true
  and .checks.session_switch_regressions.active_server_snapback_count == 0
  and .checks.session_switch_regressions.stale_opencode_session_count == 0
' "$negative_space_proof_file" >/dev/null
while IFS= read -r entry; do
  require_evidence_entry "$target_dir" "$entry"
done < <(jq -r '.evidence[]' "$negative_space_proof_file")

drill_summary_files=()
for drill in "${required_drills[@]}"; do
  summary_file="$drills_dir/$drill/summary.json"
  drill_dir="$drills_dir/$drill"
  require_json_file "$summary_file"
  drill_api_url="$(jq -r '.api_url // ""' "$summary_file")"
  require_real_target_url "$drill drill api_url" "$drill_api_url"
  jq -e --arg drill "$drill" '
    .drill == $drill
    and .status == "passed"
    and .evidence_contract_version == 1
    and (.api_url | type == "string" and length > 0)
    and (.ops_overview_file | type == "string" and length > 0)
    and (.summary | type == "string" and length > 0)
    and (.evidence | type == "array" and length > 0)
  ' "$summary_file" >/dev/null
  drill_ops_file="$(resolve_evidence_file "$drill_dir" "$(jq -r '.ops_overview_file' "$summary_file")")"
  require_json_file "$drill_ops_file"
  jq -e '.api.status == "ok"' "$drill_ops_file" >/dev/null
  while IFS= read -r entry; do
    require_evidence_entry "$drill_dir" "$entry"
  done < <(jq -r '.evidence[]' "$summary_file")
  drill_summary_files+=("$summary_file")
done

mkdir -p "$(dirname "$manifest_file")"
drills_json="$(mktemp)"
jq -s '.' "${drill_summary_files[@]}" >"$drills_json"
if [ "${GATE5_ALLOW_SYNTHETIC_EVIDENCE:-0}" = "1" ]; then
  manifest_status="synthetic-complete"
  release_eligible_json=false
  non_release_manifest_reason="synthetic evidence mode"
elif [ "$insecure_target_url_seen" = "1" ]; then
  manifest_status="insecure-target-complete"
  release_eligible_json=false
  non_release_manifest_reason="insecure target URLs"
elif [ "$insecure_evidence_url_seen" = "1" ]; then
  manifest_status="insecure-evidence-complete"
  release_eligible_json=false
  non_release_manifest_reason="insecure evidence artifact URLs"
else
  manifest_status="complete"
  release_eligible_json=true
  non_release_manifest_reason=""
fi
if [ "$release_eligible_json" = "false" ] && [ "${GATE5_ALLOW_NON_RELEASE_MANIFEST:-0}" != "1" ]; then
  echo "[gate5-verify] Refusing to write a non-release manifest for $non_release_manifest_reason without GATE5_ALLOW_NON_RELEASE_MANIFEST=1" >&2
  echo "[gate5-verify] Fixture-only modes can validate structure, but they do not prove Gate 5 completion." >&2
  exit 1
fi
jq -n \
  --slurpfile local "$local_summary_file" \
  --slurpfile self_hosted "$self_hosted_summary_file" \
  --slurpfile self_hosted_playwright "$self_hosted_playwright_file" \
  --slurpfile target "$target_summary_file" \
  --slurpfile ops "$ops_file" \
  --slurpfile playwright "$playwright_report_file" \
  --slurpfile api_curl "$api_curl_proof_file" \
  --slurpfile managed_logs "$managed_log_proof_file" \
  --slurpfile otel_traces "$otel_trace_proof_file" \
  --slurpfile slos "$slo_proof_file" \
  --slurpfile concurrency "$concurrency_proof_file" \
  --slurpfile negative_space "$negative_space_proof_file" \
  --slurpfile drills "$drills_json" \
  --arg generated_at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
  --arg manifest_status "$manifest_status" \
  --arg synthetic_evidence_allowed "${GATE5_ALLOW_SYNTHETIC_EVIDENCE:-0}" \
  --arg insecure_target_urls_allowed "${GATE5_ALLOW_INSECURE_TARGET_URLS:-0}" \
  --arg insecure_target_url_seen "$insecure_target_url_seen" \
  --arg insecure_evidence_url_seen "$insecure_evidence_url_seen" \
  --arg non_release_manifest_acknowledged "${GATE5_ALLOW_NON_RELEASE_MANIFEST:-0}" \
  --argjson release_eligible "$release_eligible_json" \
  --argjson ops_exception_count "$ops_exception_count" \
  --arg local_evidence_dir "$local_dir" \
  --arg self_hosted_evidence_dir "$self_hosted_dir" \
  --arg target_evidence_dir "$target_dir" \
  --arg drills_evidence_dir "$drills_dir" \
  '{
    status: $manifest_status,
    release_eligible: $release_eligible,
    synthetic_evidence_allowed: ($synthetic_evidence_allowed == "1"),
    insecure_target_urls_allowed: ($insecure_target_urls_allowed == "1"),
    insecure_target_url_seen: ($insecure_target_url_seen == "1"),
    insecure_evidence_url_seen: ($insecure_evidence_url_seen == "1"),
    non_release_manifest_acknowledged: ($non_release_manifest_acknowledged == "1"),
    generated_at: $generated_at,
    objective: "Complete Gate 5 production-ready v1 verification",
    canonical_spec_sections: ["0.2", "3", "5", "7", "10", "12"],
    local_verification: $local[0],
    self_hosted_golden: {
      summary: $self_hosted[0],
      playwright: {
        stats: $self_hosted_playwright[0].stats,
        spec_files: [$self_hosted_playwright[0].suites[].file]
      }
    },
    target_rehearsal: $target[0],
    target_playwright: {
      stats: $playwright[0].stats,
      spec_files: [$playwright[0].suites[].file]
    },
    target_api_curl_proof: $api_curl[0],
    target_ops: {
      generated_at: $ops[0].generated_at,
      api: $ops[0].api,
      totals: $ops[0].totals,
      sessions: $ops[0].sessions,
      sandboxes: $ops[0].sandboxes,
      audit: $ops[0].audit,
      usage: $ops[0].usage,
      observability: $ops[0].observability,
      migrations: $ops[0].migrations
    },
    target_ops_exception_count: $ops_exception_count,
    observability_proofs: {
      managed_logs: $managed_logs[0],
      otel_traces: $otel_traces[0]
    },
    slo_proof: $slos[0],
    concurrency_proof: $concurrency[0],
    negative_space_proof: $negative_space[0],
    runbook_drills: $drills[0],
    evidence_dirs: {
      local: $local_evidence_dir,
      self_hosted: $self_hosted_evidence_dir,
      target: $target_evidence_dir,
      drills: $drills_evidence_dir
    }
  }' >"$manifest_file"
rm -f "$drills_json"

if [ "${GATE5_ALLOW_SYNTHETIC_EVIDENCE:-0}" = "1" ]; then
  echo "[gate5-verify] Synthetic evidence mode was enabled; manifest is not release-eligible and does not prove Gate 5 completion"
  echo "[gate5-verify] Synthetic fixture structure is complete"
elif [ "$insecure_target_url_seen" = "1" ]; then
  echo "[gate5-verify] Insecure target URLs were allowed; manifest is not release-eligible and does not prove Gate 5 completion"
  echo "[gate5-verify] Insecure target fixture structure is complete"
elif [ "$insecure_evidence_url_seen" = "1" ]; then
  echo "[gate5-verify] Insecure evidence artifact URLs were allowed; manifest is not release-eligible and does not prove Gate 5 completion"
  echo "[gate5-verify] Insecure evidence fixture structure is complete"
else
  echo "[gate5-verify] Gate 5 target and runbook evidence is complete"
fi
echo "[gate5-verify] Release manifest written to $manifest_file"
