#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  GATE5_SLO_CONFIRM=I_VERIFIED_TARGET_SLOS \
  GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
  GATE5_SLO_SESSION_CREATE_P95_MS=740 \
  GATE5_SLO_SANDBOX_PROVIDER=daytona \
  GATE5_SLO_SANDBOX_ACTIVE_P95_MS=32000 \
  GATE5_SLO_PROXY_HEALTH_P95_MS=120 \
  GATE5_SLO_LLM_ROUTER_OVERHEAD_MEDIAN_MS=35 \
  GATE5_SLO_PROJECTS_FIRST_PAINT_P95_MS=900 \
  GATE5_SLO_EVIDENCE=$'slo-dashboard-url\nload-test-export.json' \
  bash tests/e2e/scripts/record-gate5-slo-proof.sh

Reads:
  $GATE5_TARGET_EVIDENCE_DIR/summary.json

Writes:
  $GATE5_TARGET_EVIDENCE_DIR/slo-proof.json
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-slo] Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[gate5-slo] Missing required env var: $name" >&2
    exit 1
  fi
}

require_number() {
  local name="$1"
  local value="${!name:-}"
  if ! jq -en --arg value "$value" '($value | tonumber) >= 0' >/dev/null; then
    echo "[gate5-slo] $name must be a non-negative number" >&2
    exit 1
  fi
}

require_evidence_entry() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    case "$entry" in
      http://example.*|https://example.*|http://*.example.*|https://*.example.*|http://localhost*|https://localhost*|http://127.*|https://127.*)
        echo "[gate5-slo] Refusing placeholder evidence URL: $entry" >&2
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

  echo "[gate5-slo] Missing evidence artifact: $entry in $base_dir" >&2
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

if [ "${GATE5_SLO_CONFIRM:-}" != "I_VERIFIED_TARGET_SLOS" ]; then
  echo "[gate5-slo] Refusing to record without GATE5_SLO_CONFIRM=I_VERIFIED_TARGET_SLOS" >&2
  exit 1
fi

require_env GATE5_TARGET_EVIDENCE_DIR
require_env GATE5_SLO_SESSION_CREATE_P95_MS
require_env GATE5_SLO_SANDBOX_PROVIDER
require_env GATE5_SLO_SANDBOX_ACTIVE_P95_MS
require_env GATE5_SLO_PROXY_HEALTH_P95_MS
require_env GATE5_SLO_LLM_ROUTER_OVERHEAD_MEDIAN_MS
require_env GATE5_SLO_PROJECTS_FIRST_PAINT_P95_MS
require_env GATE5_SLO_EVIDENCE

require_number GATE5_SLO_SESSION_CREATE_P95_MS
require_number GATE5_SLO_SANDBOX_ACTIVE_P95_MS
require_number GATE5_SLO_PROXY_HEALTH_P95_MS
require_number GATE5_SLO_LLM_ROUTER_OVERHEAD_MEDIAN_MS
require_number GATE5_SLO_PROJECTS_FIRST_PAINT_P95_MS

summary_file="$GATE5_TARGET_EVIDENCE_DIR/summary.json"
if [ ! -s "$summary_file" ]; then
  echo "[gate5-slo] Missing target summary: $summary_file" >&2
  exit 1
fi

jq -e '
  .status == "passed"
  and .target_rehearsal_runner == "tests/e2e/scripts/run-gate5-target-rehearsal.sh"
  and .evidence_contract_version == 1
  and .destructive_tests_run == true
  and .slos_enforced == "1"
' "$summary_file" >/dev/null || {
  echo "[gate5-slo] Refusing to record proof for a preflight, incomplete, stale-contract, or non-SLO-enforced target rehearsal" >&2
  exit 1
}

if [ "$GATE5_SLO_SANDBOX_PROVIDER" = "daytona" ]; then
  sandbox_active_limit_ms=45000
elif [ "$GATE5_SLO_SANDBOX_PROVIDER" = "local_docker" ]; then
  sandbox_active_limit_ms=15000
else
  echo "[gate5-slo] GATE5_SLO_SANDBOX_PROVIDER must be daytona or local_docker" >&2
  exit 1
fi
validate_evidence_list "$GATE5_TARGET_EVIDENCE_DIR" "$GATE5_SLO_EVIDENCE"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"

jq -n \
  --arg generated_at "$timestamp" \
  --arg provider "$GATE5_SLO_SANDBOX_PROVIDER" \
  --arg evidence "$GATE5_SLO_EVIDENCE" \
  --argjson session_create_p95_ms "$GATE5_SLO_SESSION_CREATE_P95_MS" \
  --argjson session_create_limit_ms 800 \
  --argjson sandbox_active_p95_ms "$GATE5_SLO_SANDBOX_ACTIVE_P95_MS" \
  --argjson sandbox_active_limit_ms "$sandbox_active_limit_ms" \
  --argjson proxy_health_p95_ms "$GATE5_SLO_PROXY_HEALTH_P95_MS" \
  --argjson proxy_health_limit_ms 250 \
  --argjson llm_router_overhead_median_ms "$GATE5_SLO_LLM_ROUTER_OVERHEAD_MEDIAN_MS" \
  --argjson llm_router_overhead_limit_ms 60 \
  --argjson projects_first_paint_p95_ms "$GATE5_SLO_PROJECTS_FIRST_PAINT_P95_MS" \
  --argjson projects_first_paint_limit_ms 1500 \
  '
  {
    status: "passed",
    generated_at: $generated_at,
    evidence_contract_version: 1,
    observed_at: $generated_at,
    metrics: {
      session_create_p95_ms: {
        observed: $session_create_p95_ms,
        limit: $session_create_limit_ms,
        ok: ($session_create_p95_ms <= $session_create_limit_ms)
      },
      sandbox_active_p95_ms: {
        provider: $provider,
        observed: $sandbox_active_p95_ms,
        limit: $sandbox_active_limit_ms,
        ok: ($sandbox_active_p95_ms <= $sandbox_active_limit_ms)
      },
      proxy_health_p95_ms: {
        observed: $proxy_health_p95_ms,
        limit: $proxy_health_limit_ms,
        ok: ($proxy_health_p95_ms <= $proxy_health_limit_ms)
      },
      llm_router_overhead_median_ms: {
        observed: $llm_router_overhead_median_ms,
        limit: $llm_router_overhead_limit_ms,
        ok: ($llm_router_overhead_median_ms <= $llm_router_overhead_limit_ms)
      },
      projects_first_paint_p95_ms: {
        observed: $projects_first_paint_p95_ms,
        limit: $projects_first_paint_limit_ms,
        ok: ($projects_first_paint_p95_ms <= $projects_first_paint_limit_ms)
      }
    },
    evidence: ($evidence | split("\n") | map(select(length > 0)))
  }
  | if all(.metrics[]; .ok == true) then . else .status = "failed" end
  ' >"$GATE5_TARGET_EVIDENCE_DIR/slo-proof.json"

jq -e '.status == "passed" and (.evidence | length > 0)' "$GATE5_TARGET_EVIDENCE_DIR/slo-proof.json" >/dev/null || {
  echo "[gate5-slo] One or more SLO metrics failed; see $GATE5_TARGET_EVIDENCE_DIR/slo-proof.json" >&2
  exit 1
}

echo "[gate5-slo] SLO proof written to $GATE5_TARGET_EVIDENCE_DIR/slo-proof.json"
