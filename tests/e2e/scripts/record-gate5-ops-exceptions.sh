#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  GATE5_OPS_EXCEPTIONS_CONFIRM=I_ACCEPT_TARGET_OPS_EXCEPTIONS \
  GATE5_TARGET_EVIDENCE_DIR=test-results/gate5-rehearsal/<timestamp> \
  GATE5_OPS_EXCEPTION_ITEMS=$'sessions.errored|Known failed session from provider drill.|incident-log.txt' \
  bash tests/e2e/scripts/record-gate5-ops-exceptions.sh

Each item is:
  signal|summary|evidence1,evidence2

Allowed signals:
  sessions.errored, sandboxes.errored

Reads:
  $GATE5_TARGET_EVIDENCE_DIR/summary.json
  $GATE5_TARGET_EVIDENCE_DIR/ops-overview.json

Writes:
  $GATE5_TARGET_EVIDENCE_DIR/ops-exceptions.json
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-ops-exceptions] Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[gate5-ops-exceptions] Missing required env var: $name" >&2
    exit 1
  fi
}

require_evidence_entry() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    case "$entry" in
      http://example.*|https://example.*|http://*.example.*|https://*.example.*|http://localhost*|https://localhost*|http://127.*|https://127.*)
        echo "[gate5-ops-exceptions] Refusing placeholder evidence URL: $entry" >&2
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

  echo "[gate5-ops-exceptions] Missing evidence artifact: $entry in $base_dir" >&2
  exit 1
}

require_cmd jq

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${GATE5_OPS_EXCEPTIONS_CONFIRM:-}" != "I_ACCEPT_TARGET_OPS_EXCEPTIONS" ]; then
  echo "[gate5-ops-exceptions] Refusing to record without GATE5_OPS_EXCEPTIONS_CONFIRM=I_ACCEPT_TARGET_OPS_EXCEPTIONS" >&2
  exit 1
fi

require_env GATE5_TARGET_EVIDENCE_DIR
require_env GATE5_OPS_EXCEPTION_ITEMS

summary_file="$GATE5_TARGET_EVIDENCE_DIR/summary.json"
if [ ! -s "$summary_file" ]; then
  echo "[gate5-ops-exceptions] Missing target summary: $summary_file" >&2
  exit 1
fi

jq -e '
  .status == "passed"
  and .target_rehearsal_runner == "tests/e2e/scripts/run-gate5-target-rehearsal.sh"
  and .evidence_contract_version == 1
  and .destructive_tests_run == true
' "$summary_file" >/dev/null || {
  echo "[gate5-ops-exceptions] Refusing to record proof for a preflight, incomplete, or stale-contract target rehearsal" >&2
  exit 1
}

ops_file="$GATE5_TARGET_EVIDENCE_DIR/ops-overview.json"
if [ ! -s "$ops_file" ]; then
  echo "[gate5-ops-exceptions] Missing target ops overview: $ops_file" >&2
  exit 1
fi

required_signals="$(jq -c '
  [
    (if (.sessions.errored // 0) > 0 then "sessions.errored" else empty end),
    (if (.sandboxes.errored // 0) > 0 then "sandboxes.errored" else empty end)
  ]
' "$ops_file")"

if [ "$(jq -r 'length' <<<"$required_signals")" -eq 0 ]; then
  echo "[gate5-ops-exceptions] Target ops overview has no queued/error signals requiring exceptions" >&2
  exit 1
fi

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
tmp_file="$(mktemp "$GATE5_TARGET_EVIDENCE_DIR/ops-exceptions.json.XXXXXX")"
cleanup_tmp() {
  rm -f "$tmp_file"
}
trap cleanup_tmp EXIT
jq -Rn \
  --arg generated_at "$timestamp" \
  --arg input "$GATE5_OPS_EXCEPTION_ITEMS" \
  --argjson required_signals "$required_signals" '
    def trim: gsub("^\\s+|\\s+$"; "");
    {
      status: "accepted",
      generated_at: $generated_at,
      evidence_contract_version: 1,
      exceptions: (
        $input
        | split("\n")
        | map(select(length > 0))
        | map(split("|"))
        | map({
            signal: (.[0] // "" | trim),
            summary: (.[1] // "" | trim),
            evidence: ((.[2] // "") | split(",") | map(trim) | map(select(length > 0)))
          })
      )
    }
    | if ((.exceptions | length) == 0) then error("no exceptions were provided") else . end
    | if (all(.exceptions[]; (.signal | IN("sessions.errored", "sandboxes.errored")))) then . else error("invalid exception signal") end
    | if (all(.exceptions[]; (.summary | length > 0) and (.evidence | length > 0))) then . else error("each exception needs summary and evidence") end
    | if (($required_signals - ([.exceptions[].signal] | unique)) | length == 0) then . else error("missing required ops exception signal") end
  ' >"$tmp_file"

while IFS= read -r entry; do
  require_evidence_entry "$GATE5_TARGET_EVIDENCE_DIR" "$entry"
done < <(jq -r '.exceptions[].evidence[]' "$tmp_file")

mv "$tmp_file" "$GATE5_TARGET_EVIDENCE_DIR/ops-exceptions.json"
trap - EXIT

echo "[gate5-ops-exceptions] Wrote $GATE5_TARGET_EVIDENCE_DIR/ops-exceptions.json"
