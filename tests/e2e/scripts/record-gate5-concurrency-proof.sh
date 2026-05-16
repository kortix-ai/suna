#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  GATE5_CONCURRENCY_CONFIRM=I_VERIFIED_TARGET_CONCURRENCY \
  GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
  GATE5_CONCURRENCY_PARALLEL_SESSION_REQUESTS=10 \
  GATE5_CONCURRENCY_DISTINCT_SESSION_IDS=10 \
  GATE5_CONCURRENCY_BRANCHES_PUSHED=10 \
  GATE5_CONCURRENCY_SANDBOX_ROWS=10 \
  GATE5_CONCURRENCY_DUPLICATE_KEY_ERRORS=0 \
  GATE5_CONCURRENCY_INVITE_MEMBER_ROWS=1 \
  GATE5_CONCURRENCY_INVITE_IDEMPOTENT_SEEN=1 \
  GATE5_CONCURRENCY_SANDBOX_RACE_CONSISTENT=1 \
  GATE5_CONCURRENCY_CAP_STATUS=429 \
  GATE5_CONCURRENCY_CAP_BRANCH_CREATED=0 \
  GATE5_CONCURRENCY_CAP_SANDBOX_CREATED=0 \
  GATE5_CONCURRENCY_EVIDENCE=$'parallel-session-export.json\ncap-enforcement-output.txt' \
  bash tests/e2e/scripts/record-gate5-concurrency-proof.sh

Reads:
  $GATE5_TARGET_EVIDENCE_DIR/summary.json

Writes:
  $GATE5_TARGET_EVIDENCE_DIR/concurrency-proof.json
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-concurrency] Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[gate5-concurrency] Missing required env var: $name" >&2
    exit 1
  fi
}

require_int() {
  local name="$1"
  local value="${!name:-}"
  if ! jq -en --arg value "$value" '($value | test("^[0-9]+$"))' >/dev/null; then
    echo "[gate5-concurrency] $name must be a non-negative integer" >&2
    exit 1
  fi
}

require_evidence_entry() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    case "$entry" in
      http://example.*|https://example.*|http://*.example.*|https://*.example.*|http://localhost*|https://localhost*|http://127.*|https://127.*)
        echo "[gate5-concurrency] Refusing placeholder evidence URL: $entry" >&2
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

  echo "[gate5-concurrency] Missing evidence artifact: $entry in $base_dir" >&2
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

if [ "${GATE5_CONCURRENCY_CONFIRM:-}" != "I_VERIFIED_TARGET_CONCURRENCY" ]; then
  echo "[gate5-concurrency] Refusing to record without GATE5_CONCURRENCY_CONFIRM=I_VERIFIED_TARGET_CONCURRENCY" >&2
  exit 1
fi

require_env GATE5_TARGET_EVIDENCE_DIR
require_env GATE5_CONCURRENCY_PARALLEL_SESSION_REQUESTS
require_env GATE5_CONCURRENCY_DISTINCT_SESSION_IDS
require_env GATE5_CONCURRENCY_BRANCHES_PUSHED
require_env GATE5_CONCURRENCY_SANDBOX_ROWS
require_env GATE5_CONCURRENCY_DUPLICATE_KEY_ERRORS
require_env GATE5_CONCURRENCY_INVITE_MEMBER_ROWS
require_env GATE5_CONCURRENCY_INVITE_IDEMPOTENT_SEEN
require_env GATE5_CONCURRENCY_SANDBOX_RACE_CONSISTENT
require_env GATE5_CONCURRENCY_CAP_STATUS
require_env GATE5_CONCURRENCY_CAP_BRANCH_CREATED
require_env GATE5_CONCURRENCY_CAP_SANDBOX_CREATED
require_env GATE5_CONCURRENCY_EVIDENCE

for name in \
  GATE5_CONCURRENCY_PARALLEL_SESSION_REQUESTS \
  GATE5_CONCURRENCY_DISTINCT_SESSION_IDS \
  GATE5_CONCURRENCY_BRANCHES_PUSHED \
  GATE5_CONCURRENCY_SANDBOX_ROWS \
  GATE5_CONCURRENCY_DUPLICATE_KEY_ERRORS \
  GATE5_CONCURRENCY_INVITE_MEMBER_ROWS \
  GATE5_CONCURRENCY_INVITE_IDEMPOTENT_SEEN \
  GATE5_CONCURRENCY_SANDBOX_RACE_CONSISTENT \
  GATE5_CONCURRENCY_CAP_STATUS \
  GATE5_CONCURRENCY_CAP_BRANCH_CREATED \
  GATE5_CONCURRENCY_CAP_SANDBOX_CREATED; do
  require_int "$name"
done

summary_file="$GATE5_TARGET_EVIDENCE_DIR/summary.json"
if [ ! -s "$summary_file" ]; then
  echo "[gate5-concurrency] Missing target summary: $summary_file" >&2
  exit 1
fi

jq -e '
  .status == "passed"
  and .target_rehearsal_runner == "tests/e2e/scripts/run-gate5-target-rehearsal.sh"
  and .evidence_contract_version == 1
  and .destructive_tests_run == true
' "$summary_file" >/dev/null || {
  echo "[gate5-concurrency] Refusing to record proof for a preflight, incomplete, or stale-contract target rehearsal" >&2
  exit 1
}
validate_evidence_list "$GATE5_TARGET_EVIDENCE_DIR" "$GATE5_CONCURRENCY_EVIDENCE"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"

jq -n \
  --arg generated_at "$timestamp" \
  --arg evidence "$GATE5_CONCURRENCY_EVIDENCE" \
  --argjson parallel_session_requests "$GATE5_CONCURRENCY_PARALLEL_SESSION_REQUESTS" \
  --argjson distinct_session_ids "$GATE5_CONCURRENCY_DISTINCT_SESSION_IDS" \
  --argjson branches_pushed "$GATE5_CONCURRENCY_BRANCHES_PUSHED" \
  --argjson sandbox_rows "$GATE5_CONCURRENCY_SANDBOX_ROWS" \
  --argjson duplicate_key_errors "$GATE5_CONCURRENCY_DUPLICATE_KEY_ERRORS" \
  --argjson invite_member_rows "$GATE5_CONCURRENCY_INVITE_MEMBER_ROWS" \
  --argjson invite_idempotent_seen "$GATE5_CONCURRENCY_INVITE_IDEMPOTENT_SEEN" \
  --argjson sandbox_race_consistent "$GATE5_CONCURRENCY_SANDBOX_RACE_CONSISTENT" \
  --argjson cap_status "$GATE5_CONCURRENCY_CAP_STATUS" \
  --argjson cap_branch_created "$GATE5_CONCURRENCY_CAP_BRANCH_CREATED" \
  --argjson cap_sandbox_created "$GATE5_CONCURRENCY_CAP_SANDBOX_CREATED" \
  '
  {
    status: "passed",
    generated_at: $generated_at,
    evidence_contract_version: 1,
    observed_at: $generated_at,
    checks: {
      parallel_session_creates: {
        requested: $parallel_session_requests,
        distinct_session_ids: $distinct_session_ids,
        branches_pushed: $branches_pushed,
        sandbox_rows: $sandbox_rows,
        duplicate_key_errors: $duplicate_key_errors,
        ok: (
          $parallel_session_requests >= 10
          and $distinct_session_ids == $parallel_session_requests
          and $branches_pushed == $parallel_session_requests
          and $sandbox_rows == $parallel_session_requests
          and $duplicate_key_errors == 0
        )
      },
      concurrent_invite_accepts: {
        member_rows: $invite_member_rows,
        idempotent_response_seen: ($invite_idempotent_seen == 1),
        ok: ($invite_member_rows == 1 and $invite_idempotent_seen == 1)
      },
      sandbox_active_race: {
        row_consistent: ($sandbox_race_consistent == 1),
        ok: ($sandbox_race_consistent == 1)
      },
      cap_enforcement: {
        status: $cap_status,
        branch_created: ($cap_branch_created == 1),
        sandbox_created: ($cap_sandbox_created == 1),
        ok: ($cap_status == 429 and $cap_branch_created == 0 and $cap_sandbox_created == 0)
      }
    },
    evidence: ($evidence | split("\n") | map(select(length > 0)))
  }
  | if all(.checks[]; .ok == true) then . else .status = "failed" end
  ' >"$GATE5_TARGET_EVIDENCE_DIR/concurrency-proof.json"

jq -e '.status == "passed" and (.evidence | length > 0)' "$GATE5_TARGET_EVIDENCE_DIR/concurrency-proof.json" >/dev/null || {
  echo "[gate5-concurrency] One or more concurrency checks failed; see $GATE5_TARGET_EVIDENCE_DIR/concurrency-proof.json" >&2
  exit 1
}

echo "[gate5-concurrency] Concurrency proof written to $GATE5_TARGET_EVIDENCE_DIR/concurrency-proof.json"
