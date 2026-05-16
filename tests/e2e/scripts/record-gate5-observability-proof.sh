#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  GATE5_OBSERVABILITY_CONFIRM=I_VERIFIED_TARGET_OBSERVABILITY \
  GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
  GATE5_MANAGED_LOG_SINK="Better Stack production source" \
  GATE5_MANAGED_LOG_EVIDENCE=$'better-stack-query-url\nscreenshot-or-export.json' \
  GATE5_OTEL_TRACE_SINK="Tempo production tenant" \
  GATE5_OTEL_TRACE_EVIDENCE=$'trace-query-url\ntrace-export.json' \
  bash tests/e2e/scripts/record-gate5-observability-proof.sh

Reads:
  $GATE5_TARGET_EVIDENCE_DIR/summary.json

Writes:
  $GATE5_TARGET_EVIDENCE_DIR/managed-log-proof.json
  $GATE5_TARGET_EVIDENCE_DIR/otel-trace-proof.json
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-observability] Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[gate5-observability] Missing required env var: $name" >&2
    exit 1
  fi
}

require_evidence_entry() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    case "$entry" in
      http://example.*|https://example.*|http://*.example.*|https://*.example.*|http://localhost*|https://localhost*|http://127.*|https://127.*)
        echo "[gate5-observability] Refusing placeholder evidence URL: $entry" >&2
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

  echo "[gate5-observability] Missing evidence artifact: $entry in $base_dir" >&2
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

if [ "${GATE5_OBSERVABILITY_CONFIRM:-}" != "I_VERIFIED_TARGET_OBSERVABILITY" ]; then
  echo "[gate5-observability] Refusing to record without GATE5_OBSERVABILITY_CONFIRM=I_VERIFIED_TARGET_OBSERVABILITY" >&2
  exit 1
fi

require_env GATE5_TARGET_EVIDENCE_DIR
require_env GATE5_MANAGED_LOG_SINK
require_env GATE5_MANAGED_LOG_EVIDENCE
require_env GATE5_OTEL_TRACE_SINK
require_env GATE5_OTEL_TRACE_EVIDENCE

summary_file="$GATE5_TARGET_EVIDENCE_DIR/summary.json"
if [ ! -s "$summary_file" ]; then
  echo "[gate5-observability] Missing target summary: $summary_file" >&2
  exit 1
fi

jq -e '
  .status == "passed"
  and .target_rehearsal_runner == "tests/e2e/scripts/run-gate5-target-rehearsal.sh"
  and .evidence_contract_version == 1
  and .destructive_tests_run == true
' "$summary_file" >/dev/null || {
  echo "[gate5-observability] Refusing to record proof for a preflight, incomplete, or stale-contract target rehearsal" >&2
  exit 1
}

request_id="$(jq -r '.observability_probe.request_id // empty' "$summary_file")"
trace_id="$(jq -r '.observability_probe.trace_id // empty' "$summary_file")"
response_traceparent="$(jq -r '.observability_probe.response_traceparent // empty' "$summary_file")"

if [ -z "$request_id" ] || [ -z "$trace_id" ]; then
  echo "[gate5-observability] Target summary does not contain observability_probe.request_id and trace_id" >&2
  exit 1
fi
if ! printf '%s' "$trace_id" | grep -Eq '^[0-9a-f]{32}$'; then
  echo "[gate5-observability] Target summary observability_probe.trace_id is not a W3C trace id" >&2
  exit 1
fi
validate_evidence_list "$GATE5_TARGET_EVIDENCE_DIR" "$GATE5_MANAGED_LOG_EVIDENCE"
validate_evidence_list "$GATE5_TARGET_EVIDENCE_DIR" "$GATE5_OTEL_TRACE_EVIDENCE"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"

jq -n \
  --arg generated_at "$timestamp" \
  --arg sink "$GATE5_MANAGED_LOG_SINK" \
  --arg request_id "$request_id" \
  --arg trace_id "$trace_id" \
  --arg response_traceparent "$response_traceparent" \
  --arg evidence "$GATE5_MANAGED_LOG_EVIDENCE" \
  '{
    status: "passed",
    generated_at: $generated_at,
    evidence_contract_version: 1,
    observed_at: $generated_at,
    sink: $sink,
    probe: {
      request_id: $request_id,
      trace_id: $trace_id,
      response_traceparent: $response_traceparent
    },
    required_fields: ["request_id", "trace_id"],
    evidence: ($evidence | split("\n") | map(select(length > 0)))
  }' >"$GATE5_TARGET_EVIDENCE_DIR/managed-log-proof.json"

jq -n \
  --arg generated_at "$timestamp" \
  --arg sink "$GATE5_OTEL_TRACE_SINK" \
  --arg request_id "$request_id" \
  --arg trace_id "$trace_id" \
  --arg response_traceparent "$response_traceparent" \
  --arg evidence "$GATE5_OTEL_TRACE_EVIDENCE" \
  '{
    status: "passed",
    generated_at: $generated_at,
    evidence_contract_version: 1,
    observed_at: $generated_at,
    sink: $sink,
    probe: {
      request_id: $request_id,
      trace_id: $trace_id,
      response_traceparent: $response_traceparent
    },
    required_fields: ["traceId", "parentSpanId", "service.name"],
    evidence: ($evidence | split("\n") | map(select(length > 0)))
  }' >"$GATE5_TARGET_EVIDENCE_DIR/otel-trace-proof.json"

echo "[gate5-observability] Managed log proof written to $GATE5_TARGET_EVIDENCE_DIR/managed-log-proof.json"
echo "[gate5-observability] OTel trace proof written to $GATE5_TARGET_EVIDENCE_DIR/otel-trace-proof.json"
