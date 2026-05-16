#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

allowed_drills=(
  provider-failure
  stripe-failure
  db-migration-rollback
  legacy-migration-rollback
  sandbox-image-rollback
  api-deploy-rollback
)

usage() {
  cat <<'USAGE'
Usage:
  GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING \
  GATE5_DRILL_NAME=provider-failure \
  GATE5_DRILL_STATUS=passed \
  GATE5_DRILL_SUMMARY="Provider outage was detected in ops and recovery was verified." \
  GATE5_DRILL_EVIDENCE=$'ops-before.json\nops-after.json\nincident-notes.md' \
  E2E_API_URL=https://new-api.kortix.com/v1 \
  ADMIN_TOKEN=... \
  bash tests/e2e/scripts/record-gate5-runbook-drill.sh

Required drill names:
  provider-failure, stripe-failure, db-migration-rollback,
  legacy-migration-rollback, sandbox-image-rollback, api-deploy-rollback

Writes:
  $GATE5_DRILLS_EVIDENCE_DIR/<drill>/summary.json
  $GATE5_DRILLS_EVIDENCE_DIR/<drill>/ops-overview-at-record.json
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[gate5-drill] Missing required command: $1" >&2
    exit 1
  fi
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[gate5-drill] Missing required env var: $name" >&2
    exit 1
  fi
}

require_evidence_entry() {
  local base_dir="$1"
  local entry="$2"

  if [[ "$entry" =~ ^https?:// ]]; then
    case "$entry" in
      http://example.*|https://example.*|http://*.example.*|https://*.example.*|http://localhost*|https://localhost*|http://127.*|https://127.*)
        echo "[gate5-drill] Refusing placeholder evidence URL: $entry" >&2
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

  echo "[gate5-drill] Missing evidence artifact: $entry in $base_dir" >&2
  exit 1
}

contains_drill() {
  local needle="$1"
  local item
  for item in "${allowed_drills[@]}"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

require_cmd jq
require_cmd curl

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ "${GATE5_DRILL_CONFIRM:-}" != "I_REHEARSED_THIS_ON_STAGING" ]; then
  echo "[gate5-drill] Refusing to record without GATE5_DRILL_CONFIRM=I_REHEARSED_THIS_ON_STAGING" >&2
  exit 1
fi

require_env E2E_API_URL
require_env ADMIN_TOKEN
case "$E2E_API_URL" in
  https://*) ;;
  *)
    echo "[gate5-drill] E2E_API_URL must be a real HTTPS staging/target API URL" >&2
    exit 1
    ;;
esac
case "$E2E_API_URL" in
  https://localhost*|https://127.*|https://0.0.0.0*|https://10.*|https://192.168.*|https://172.16.*|https://172.17.*|https://172.18.*|https://172.19.*|https://172.20.*|https://172.21.*|https://172.22.*|https://172.23.*|https://172.24.*|https://172.25.*|https://172.26.*|https://172.27.*|https://172.28.*|https://172.29.*|https://172.30.*|https://172.31.*|https://example.*|https://*.example.*|https://*.test*|https://*.invalid*|https://*.local*)
    echo "[gate5-drill] E2E_API_URL must not be localhost, private, example, .test, .invalid, or .local" >&2
    exit 1
    ;;
esac

drill="${GATE5_DRILL_NAME:-}"
if ! contains_drill "$drill"; then
  echo "[gate5-drill] Invalid or missing GATE5_DRILL_NAME: ${drill:-<empty>}" >&2
  usage >&2
  exit 1
fi

status="${GATE5_DRILL_STATUS:-}"
if [ "$status" != "passed" ] && [ "$status" != "failed" ]; then
  echo "[gate5-drill] GATE5_DRILL_STATUS must be passed or failed" >&2
  exit 1
fi

summary="${GATE5_DRILL_SUMMARY:-}"
if [ -z "$summary" ]; then
  echo "[gate5-drill] GATE5_DRILL_SUMMARY is required" >&2
  exit 1
fi

evidence="${GATE5_DRILL_EVIDENCE:-}"
if [ -z "$evidence" ]; then
  echo "[gate5-drill] GATE5_DRILL_EVIDENCE is required" >&2
  exit 1
fi

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
root="${GATE5_DRILLS_EVIDENCE_DIR:-$REPO_ROOT/test-results/gate5-release/runbook-drills}"
drill_dir="$root/$drill"
mkdir -p "$drill_dir"

while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  require_evidence_entry "$drill_dir" "$entry"
done <<<"$evidence"

api_url="${E2E_API_URL%/}"
ops_file="ops-overview-at-record.json"
curl -fsS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$api_url/ops/overview" \
  -o "$drill_dir/$ops_file"
jq -e '.api.status == "ok"' "$drill_dir/$ops_file" >/dev/null

jq -n \
  --arg generated_at "$timestamp" \
  --arg drill "$drill" \
  --arg status "$status" \
  --arg summary "$summary" \
  --arg api_url "$api_url" \
  --arg ops_overview_file "$ops_file" \
  --arg evidence "$evidence" \
  '{
    evidence_contract_version: 1,
    generated_at: $generated_at,
    drill: $drill,
    status: $status,
    summary: $summary,
    api_url: (if $api_url == "" then null else $api_url end),
    ops_overview_file: (if $ops_overview_file == "" then null else $ops_overview_file end),
    evidence: ($evidence | split("\n") | map(select(length > 0)))
  }' >"$drill_dir/summary.json"

echo "[gate5-drill] Recorded $drill drill evidence at $drill_dir/summary.json"
