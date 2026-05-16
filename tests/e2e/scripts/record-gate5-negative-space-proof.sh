#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  GATE5_NEGATIVE_CONFIRM=I_VERIFIED_TARGET_NEGATIVE_SPACE \
  GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
  GATE5_NEGATIVE_INSTANCES_URL_COUNT=0 \
  GATE5_NEGATIVE_BARE_SESSIONS_URL_COUNT=0 \
  GATE5_NEGATIVE_DASHBOARD_REDIRECT_COUNT=0 \
  GATE5_NEGATIVE_RIGHT_RAIL_COUNT=0 \
  GATE5_NEGATIVE_JUSTAVPS_BANNER_COUNT=0 \
  GATE5_NEGATIVE_JUSTAVPS_SESSION_STATUS=400 \
  GATE5_NEGATIVE_MEMBER_PROXY_STATUS=200 \
  GATE5_NEGATIVE_OUTSIDER_PROXY_STATUS=403 \
  GATE5_NEGATIVE_REMOVED_USER_PROXY_STATUS=403 \
  GATE5_NEGATIVE_REMOVED_USER_PROXY_SECONDS=4.2 \
  GATE5_NEGATIVE_LEGACY_SANDBOX_ROWS=0 \
  GATE5_NEGATIVE_LEGACY_PLATFORM_PROJECT_ROWS=0 \
  GATE5_NEGATIVE_ACTIVE_SERVER_SNAPBACK_COUNT=0 \
  GATE5_NEGATIVE_STALE_OPENCODE_SESSION_COUNT=0 \
  GATE5_NEGATIVE_EVIDENCE=$'negative-space-export.json\nui-snapshot.txt' \
  bash tests/e2e/scripts/record-gate5-negative-space-proof.sh

Reads:
  $GATE5_TARGET_EVIDENCE_DIR/summary.json

Writes:
  $GATE5_TARGET_EVIDENCE_DIR/negative-space-proof.json
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-negative] Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[gate5-negative] Missing required env var: $name" >&2
    exit 1
  fi
}

require_int() {
  local name="$1"
  local value="${!name:-}"
  if ! jq -en --arg value "$value" '($value | test("^[0-9]+$"))' >/dev/null; then
    echo "[gate5-negative] $name must be a non-negative integer" >&2
    exit 1
  fi
}

require_evidence_entry() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    case "$entry" in
      http://example.*|https://example.*|http://*.example.*|https://*.example.*|http://localhost*|https://localhost*|http://127.*|https://127.*)
        echo "[gate5-negative] Refusing placeholder evidence URL: $entry" >&2
        exit 1
        ;;
    esac
    return 0
  fi
  if [ -f "$entry" ]; then
    return 0
  fi
  if [ -f "$base_dir/$entry" ]; then
    return 0
  fi

  echo "[gate5-negative] Missing evidence artifact: $entry in $base_dir" >&2
  exit 1
}

validate_evidence_list() {
  local base_dir="$1"
  local evidence="$2"
  local entry

  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    require_evidence_entry "$base_dir" "$entry"
  done <<<"$evidence"
}

require_cmd jq

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${GATE5_NEGATIVE_CONFIRM:-}" != "I_VERIFIED_TARGET_NEGATIVE_SPACE" ]; then
  echo "[gate5-negative] Refusing to record without GATE5_NEGATIVE_CONFIRM=I_VERIFIED_TARGET_NEGATIVE_SPACE" >&2
  exit 1
fi

require_env GATE5_TARGET_EVIDENCE_DIR
require_env GATE5_NEGATIVE_INSTANCES_URL_COUNT
require_env GATE5_NEGATIVE_BARE_SESSIONS_URL_COUNT
require_env GATE5_NEGATIVE_DASHBOARD_REDIRECT_COUNT
require_env GATE5_NEGATIVE_RIGHT_RAIL_COUNT
require_env GATE5_NEGATIVE_JUSTAVPS_BANNER_COUNT
require_env GATE5_NEGATIVE_JUSTAVPS_SESSION_STATUS
require_env GATE5_NEGATIVE_MEMBER_PROXY_STATUS
require_env GATE5_NEGATIVE_OUTSIDER_PROXY_STATUS
require_env GATE5_NEGATIVE_REMOVED_USER_PROXY_STATUS
require_env GATE5_NEGATIVE_REMOVED_USER_PROXY_SECONDS
require_env GATE5_NEGATIVE_LEGACY_SANDBOX_ROWS
require_env GATE5_NEGATIVE_LEGACY_PLATFORM_PROJECT_ROWS
require_env GATE5_NEGATIVE_ACTIVE_SERVER_SNAPBACK_COUNT
require_env GATE5_NEGATIVE_STALE_OPENCODE_SESSION_COUNT
require_env GATE5_NEGATIVE_EVIDENCE

for name in \
  GATE5_NEGATIVE_INSTANCES_URL_COUNT \
  GATE5_NEGATIVE_BARE_SESSIONS_URL_COUNT \
  GATE5_NEGATIVE_DASHBOARD_REDIRECT_COUNT \
  GATE5_NEGATIVE_RIGHT_RAIL_COUNT \
  GATE5_NEGATIVE_JUSTAVPS_BANNER_COUNT \
  GATE5_NEGATIVE_JUSTAVPS_SESSION_STATUS \
  GATE5_NEGATIVE_MEMBER_PROXY_STATUS \
  GATE5_NEGATIVE_OUTSIDER_PROXY_STATUS \
  GATE5_NEGATIVE_REMOVED_USER_PROXY_STATUS \
  GATE5_NEGATIVE_LEGACY_SANDBOX_ROWS \
  GATE5_NEGATIVE_LEGACY_PLATFORM_PROJECT_ROWS \
  GATE5_NEGATIVE_ACTIVE_SERVER_SNAPBACK_COUNT \
  GATE5_NEGATIVE_STALE_OPENCODE_SESSION_COUNT; do
  require_int "$name"
done
if ! jq -en --arg value "$GATE5_NEGATIVE_REMOVED_USER_PROXY_SECONDS" '($value | tonumber) >= 0' >/dev/null; then
  echo "[gate5-negative] GATE5_NEGATIVE_REMOVED_USER_PROXY_SECONDS must be a non-negative number" >&2
  exit 1
fi

summary_file="$GATE5_TARGET_EVIDENCE_DIR/summary.json"
if [ ! -s "$summary_file" ]; then
  echo "[gate5-negative] Missing target summary: $summary_file" >&2
  exit 1
fi

jq -e '
  .status == "passed"
  and .target_rehearsal_runner == "tests/e2e/scripts/run-gate5-target-rehearsal.sh"
  and .evidence_contract_version == 1
  and .destructive_tests_run == true
' "$summary_file" >/dev/null || {
  echo "[gate5-negative] Refusing to record proof for a preflight, incomplete, or stale-contract target rehearsal" >&2
  exit 1
}
validate_evidence_list "$GATE5_TARGET_EVIDENCE_DIR" "$GATE5_NEGATIVE_EVIDENCE"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"

jq -n \
  --arg generated_at "$timestamp" \
  --arg evidence "$GATE5_NEGATIVE_EVIDENCE" \
  --argjson instances_url_count "$GATE5_NEGATIVE_INSTANCES_URL_COUNT" \
  --argjson bare_sessions_url_count "$GATE5_NEGATIVE_BARE_SESSIONS_URL_COUNT" \
  --argjson dashboard_redirect_count "$GATE5_NEGATIVE_DASHBOARD_REDIRECT_COUNT" \
  --argjson right_rail_count "$GATE5_NEGATIVE_RIGHT_RAIL_COUNT" \
  --argjson justavps_banner_count "$GATE5_NEGATIVE_JUSTAVPS_BANNER_COUNT" \
  --argjson justavps_session_status "$GATE5_NEGATIVE_JUSTAVPS_SESSION_STATUS" \
  --argjson member_proxy_status "$GATE5_NEGATIVE_MEMBER_PROXY_STATUS" \
  --argjson outsider_proxy_status "$GATE5_NEGATIVE_OUTSIDER_PROXY_STATUS" \
  --argjson removed_user_proxy_status "$GATE5_NEGATIVE_REMOVED_USER_PROXY_STATUS" \
  --argjson removed_user_proxy_seconds "$GATE5_NEGATIVE_REMOVED_USER_PROXY_SECONDS" \
  --argjson legacy_sandbox_rows "$GATE5_NEGATIVE_LEGACY_SANDBOX_ROWS" \
  --argjson legacy_platform_project_rows "$GATE5_NEGATIVE_LEGACY_PLATFORM_PROJECT_ROWS" \
  --argjson active_server_snapback_count "$GATE5_NEGATIVE_ACTIVE_SERVER_SNAPBACK_COUNT" \
  --argjson stale_opencode_session_count "$GATE5_NEGATIVE_STALE_OPENCODE_SESSION_COUNT" \
  '
  {
    status: "passed",
    generated_at: $generated_at,
    evidence_contract_version: 1,
    observed_at: $generated_at,
    checks: {
      legacy_urls_absent: {
        instances_url_count: $instances_url_count,
        bare_sessions_url_count: $bare_sessions_url_count,
        dashboard_redirect_count: $dashboard_redirect_count,
        ok: ($instances_url_count == 0 and $bare_sessions_url_count == 0 and $dashboard_redirect_count == 0)
      },
      legacy_ui_absent: {
        right_rail_count: $right_rail_count,
        justavps_banner_count: $justavps_banner_count,
        ok: ($right_rail_count == 0 and $justavps_banner_count == 0)
      },
      provider_whitelist: {
        justavps_session_status: $justavps_session_status,
        ok: ($justavps_session_status == 400)
      },
      sandbox_proxy_boundary: {
        member_proxy_status: $member_proxy_status,
        outsider_proxy_status: $outsider_proxy_status,
        ok: ($member_proxy_status >= 200 and $member_proxy_status < 300 and $outsider_proxy_status == 403)
      },
      removed_user_proxy_revocation: {
        proxy_status: $removed_user_proxy_status,
        observed_seconds: $removed_user_proxy_seconds,
        limit_seconds: 5,
        ok: ($removed_user_proxy_status == 403 and $removed_user_proxy_seconds <= 5)
      },
      legacy_runtime_contamination: {
        legacy_sandbox_rows: $legacy_sandbox_rows,
        legacy_platform_project_rows: $legacy_platform_project_rows,
        ok: ($legacy_sandbox_rows == 0 and $legacy_platform_project_rows == 0)
      },
      session_switch_regressions: {
        active_server_snapback_count: $active_server_snapback_count,
        stale_opencode_session_count: $stale_opencode_session_count,
        ok: ($active_server_snapback_count == 0 and $stale_opencode_session_count == 0)
      }
    },
    evidence: ($evidence | split("\n") | map(select(length > 0)))
  }
  | if all(.checks[]; .ok == true) then . else .status = "failed" end
  ' >"$GATE5_TARGET_EVIDENCE_DIR/negative-space-proof.json"

jq -e '.status == "passed" and (.evidence | length > 0)' "$GATE5_TARGET_EVIDENCE_DIR/negative-space-proof.json" >/dev/null || {
  echo "[gate5-negative] One or more negative-space checks failed; see $GATE5_TARGET_EVIDENCE_DIR/negative-space-proof.json" >&2
  exit 1
}

echo "[gate5-negative] Negative-space proof written to $GATE5_TARGET_EVIDENCE_DIR/negative-space-proof.json"
