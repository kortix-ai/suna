#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

usage() {
  cat <<'USAGE'
Usage:
  GATE5_PREFLIGHT_ONLY=1 \
  E2E_BASE_URL=https://app.example.com \
  E2E_API_URL=https://api.example.com/v1 \
  E2E_SUPABASE_URL=https://supabase.example.com \
  E2E_DATABASE_URL=postgresql://... \
  E2E_ENV_FILE=/secure/path/target.env \
  ADMIN_TOKEN=... \
  E2E_GOLDEN_PROVIDER=daytona \
  E2E_REQUIRE_GITHUB_APP=1 \
  pnpm --dir tests run test:e2e:gate5:preflight

  GATE5_TARGET_CONFIRM=I_UNDERSTAND_THIS_CREATES_TARGET_DATA \
  E2E_BASE_URL=https://app.example.com \
  E2E_API_URL=https://api.example.com/v1 \
  E2E_SUPABASE_URL=https://supabase.example.com \
  E2E_DATABASE_URL=postgresql://... \
  E2E_ENV_FILE=/secure/path/target.env \
  ADMIN_TOKEN=... \
  E2E_GOLDEN_PROVIDER=daytona \
  E2E_REQUIRE_GITHUB_APP=1 \
  E2E_ENFORCE_SLOS=1 \
  pnpm --dir tests run test:e2e:gate5:target

Writes:
  test-results/gate5-rehearsal/<timestamp>/

Notes:
  - Preflight is read-only and does not satisfy final Gate 5 evidence by itself.
  - Full target mode creates target users, repos, sessions, sandboxes, and webhook events.
  - Production Gate 5 requires daytona, GitHub App auth, managed logs, OTLP traces, enforced SLOs, and no unplanned active legacy sandboxes.
USAGE
}

for arg in "$@"; do
  if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
    usage
    exit 0
  fi
done

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
EVIDENCE_DIR="${GATE5_EVIDENCE_DIR:-$REPO_ROOT/test-results/gate5-rehearsal/$timestamp}"
mkdir -p "$EVIDENCE_DIR"
LOG_FILE="$EVIDENCE_DIR/run.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[gate5] Starting target rehearsal at $timestamp"
echo "[gate5] Evidence directory: $EVIDENCE_DIR"

PREFLIGHT_ONLY="${GATE5_PREFLIGHT_ONLY:-0}"
missing_requirements=()

add_missing_requirement() {
  missing_requirements+=("$1")
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    add_missing_requirement "command:$1"
  fi
}

check_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    add_missing_requirement "env:$name"
  fi
}

env_file_has_key() {
  local key="$1"
  local files="${E2E_ENV_FILE:-}"
  local file

  IFS=':' read -r -a candidates <<<"$files"
  for file in "${candidates[@]}"; do
    [ -n "$file" ] || continue
    if [ -f "$file" ] && grep -Eq "^${key}=" "$file"; then
      return 0
    fi
  done

  return 1
}

check_env_or_file() {
  local name="$1"
  if [ -n "${!name:-}" ] || env_file_has_key "$name"; then
    return 0
  fi

  add_missing_requirement "env-or-E2E_ENV_FILE:$name"
}

flush_missing_requirements() {
  if [ "${#missing_requirements[@]}" -eq 0 ]; then
    return 0
  fi

  echo "[gate5] Missing required target rehearsal inputs:" >&2
  printf '  - %s\n' "${missing_requirements[@]}" >&2
  echo "[gate5] Run with --help to print the full target/preflight command shape." >&2
  exit 1
}

require_cmd curl
require_cmd jq
require_cmd node
require_cmd pnpm
require_cmd psql

if [ "$PREFLIGHT_ONLY" = "1" ]; then
  echo "[gate5] Preflight-only mode enabled; destructive golden paths will not run"
else
  check_env GATE5_TARGET_CONFIRM
  if [ -n "${GATE5_TARGET_CONFIRM:-}" ] && [ "$GATE5_TARGET_CONFIRM" != "I_UNDERSTAND_THIS_CREATES_TARGET_DATA" ]; then
    add_missing_requirement "env:GATE5_TARGET_CONFIRM must equal I_UNDERSTAND_THIS_CREATES_TARGET_DATA"
  fi
fi

check_env E2E_API_URL
check_env E2E_BASE_URL
check_env E2E_SUPABASE_URL
check_env E2E_DATABASE_URL
check_env ADMIN_TOKEN
check_env_or_file SUPABASE_SERVICE_ROLE_KEY

if [ -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ] && [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  if ! env_file_has_key NEXT_PUBLIC_SUPABASE_ANON_KEY && ! env_file_has_key SUPABASE_ANON_KEY; then
    add_missing_requirement "env-or-E2E_ENV_FILE:NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY"
  fi
fi

flush_missing_requirements

export DATABASE_URL="$E2E_DATABASE_URL"
export E2E_ENABLE_GOLDEN_PATHS="${E2E_ENABLE_GOLDEN_PATHS:-1}"
export E2E_REQUIRE_GITHUB_APP="${E2E_REQUIRE_GITHUB_APP:-1}"
export E2E_GOLDEN_PROVIDER="${E2E_GOLDEN_PROVIDER:-daytona}"
export E2E_GOLDEN_BACKPRESSURE="${E2E_GOLDEN_BACKPRESSURE:-1}"
export E2E_GOLDEN_LOCAL_DOCKER="${E2E_GOLDEN_LOCAL_DOCKER:-0}"
export E2E_ENFORCE_SLOS="${E2E_ENFORCE_SLOS:-1}"

if [ "${GATE5_REQUIRE_MANAGED_OBSERVABILITY:-1}" != "1" ]; then
  echo "[gate5] GATE5_REQUIRE_MANAGED_OBSERVABILITY must be 1 for Gate 5 target rehearsal" >&2
  exit 1
fi

if [ "${GATE5_REQUIRE_NO_ACTIVE_LEGACY:-1}" != "1" ]; then
  echo "[gate5] GATE5_REQUIRE_NO_ACTIVE_LEGACY must be 1 for Gate 5 target rehearsal" >&2
  exit 1
fi

if [ "$E2E_ENABLE_GOLDEN_PATHS" != "1" ]; then
  echo "[gate5] E2E_ENABLE_GOLDEN_PATHS must be 1 for Gate 5 rehearsal" >&2
  exit 1
fi

if [ "$E2E_REQUIRE_GITHUB_APP" != "1" ]; then
  echo "[gate5] E2E_REQUIRE_GITHUB_APP must be 1 for Gate 5 target rehearsal" >&2
  exit 1
fi

if [ "$E2E_GOLDEN_BACKPRESSURE" != "1" ]; then
  echo "[gate5] E2E_GOLDEN_BACKPRESSURE must be 1 for Gate 5 target rehearsal" >&2
  exit 1
fi

if [ "$E2E_ENFORCE_SLOS" != "1" ]; then
  echo "[gate5] E2E_ENFORCE_SLOS must be 1 for Gate 5 target rehearsal" >&2
  exit 1
fi

if [ "${GATE5_ALLOW_NON_CLOUD_PROVIDER:-0}" != "1" ] && [ "$E2E_GOLDEN_PROVIDER" != "daytona" ]; then
  echo "[gate5] E2E_GOLDEN_PROVIDER must be daytona for target rehearsal unless GATE5_ALLOW_NON_CLOUD_PROVIDER=1" >&2
  exit 1
fi

api_url="${E2E_API_URL%/}"
probe_trace_id="$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
probe_parent_span_id="$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
probe_traceparent="00-${probe_trace_id}-${probe_parent_span_id}-01"

header_value() {
  local header="$1"
  local file="$2"
  awk -F':[[:space:]]*' -v wanted="$(printf '%s' "$header" | tr '[:upper:]' '[:lower:]')" '
    tolower($1) == wanted {
      value = $2
      sub(/\r$/, "", value)
      print value
      exit
    }
  ' "$file"
}

echo "[gate5] Curling API health"
curl -fsS \
  -H "traceparent: $probe_traceparent" \
  -D "$EVIDENCE_DIR/health.headers" \
  "$api_url/health" \
  -o "$EVIDENCE_DIR/health.json"
jq -e '.status == "ok"' "$EVIDENCE_DIR/health.json" >/dev/null
grep -qi '^x-request-id:' "$EVIDENCE_DIR/health.headers"
grep -qi '^traceparent:' "$EVIDENCE_DIR/health.headers"
probe_request_id="$(header_value x-request-id "$EVIDENCE_DIR/health.headers")"
probe_response_traceparent="$(header_value traceparent "$EVIDENCE_DIR/health.headers")"
if ! printf '%s' "$probe_response_traceparent" | grep -Eq "^00-${probe_trace_id}-[0-9a-f]{16}-01$"; then
  echo "[gate5] Health response traceparent did not preserve the probe trace id" >&2
  exit 1
fi

echo "[gate5] Curling ops overview"
curl -fsS \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$api_url/ops/overview" \
  -o "$EVIDENCE_DIR/ops-overview.json"
jq -e '.api.status == "ok" and .observability.trace_headers_enabled == true and .observability.structured_request_logs_enabled == true and .observability.otlp_request_spans_enabled == true' "$EVIDENCE_DIR/ops-overview.json" >/dev/null

if [ "${GATE5_REQUIRE_MANAGED_OBSERVABILITY:-1}" = "1" ]; then
  jq -e '.observability.managed_logs_configured == true and .observability.otlp_exporter_configured == true and .observability.otlp_request_spans_enabled == true' "$EVIDENCE_DIR/ops-overview.json" >/dev/null
fi

if [ "${GATE5_REQUIRE_NO_ACTIVE_LEGACY:-1}" = "1" ]; then
  jq -e '(.migrations.active_legacy_sandboxes // .totals.active_legacy_sandboxes // 0) == 0' "$EVIDENCE_DIR/ops-overview.json" >/dev/null
fi

if [ "$PREFLIGHT_ONLY" = "1" ]; then
  cat >"$EVIDENCE_DIR/summary.json" <<JSON
{
  "status": "preflight-passed",
  "generated_at": "$timestamp",
  "target_rehearsal_runner": "tests/e2e/scripts/run-gate5-target-rehearsal.sh",
  "evidence_contract_version": 1,
  "api_url": "$E2E_API_URL",
  "base_url": "$E2E_BASE_URL",
  "supabase_url": "$E2E_SUPABASE_URL",
  "provider": "$E2E_GOLDEN_PROVIDER",
  "github_app_required": "$E2E_REQUIRE_GITHUB_APP",
  "golden_paths_enabled": "$E2E_ENABLE_GOLDEN_PATHS",
  "golden_backpressure_enabled": "$E2E_GOLDEN_BACKPRESSURE",
  "local_docker_golden_enabled": "$E2E_GOLDEN_LOCAL_DOCKER",
  "slos_enforced": "$E2E_ENFORCE_SLOS",
  "managed_observability_required": "${GATE5_REQUIRE_MANAGED_OBSERVABILITY:-1}",
  "no_active_legacy_required": "${GATE5_REQUIRE_NO_ACTIVE_LEGACY:-1}",
  "preflight_only": true,
  "destructive_tests_run": false,
  "observability_probe": {
    "request_id": "$probe_request_id",
    "trace_id": "$probe_trace_id",
    "incoming_traceparent": "$probe_traceparent",
    "response_traceparent": "$probe_response_traceparent",
    "expected_log_fields": ["request_id", "trace_id"],
    "expected_trace_fields": ["traceId", "parentSpanId", "service.name"]
  },
  "evidence_dir": "$EVIDENCE_DIR",
  "spec_sections": ["0.2", "3", "5", "7", "10", "12"],
  "artifacts": {
    "health": "health.json",
    "health_headers": "health.headers",
    "ops_overview": "ops-overview.json",
    "run_log": "run.log"
  }
}
JSON

  echo "[gate5] Target preflight passed"
  echo "[gate5] Evidence captured in $EVIDENCE_DIR"
  exit 0
fi

echo "[gate5] Running admin ops browser test and SPEC 10.5 golden paths"
PLAYWRIGHT_JSON_OUTPUT_FILE="$EVIDENCE_DIR/playwright-report.json" \
pnpm --dir tests exec playwright test \
  -c playwright.config.ts \
  --reporter=line,json \
  e2e/specs/08-accounts-project-access.spec.ts \
  e2e/specs/09-admin-ops.spec.ts \
  e2e/specs/10-production-golden-paths.spec.ts \
  e2e/specs/11-production-boundaries.spec.ts

cat >"$EVIDENCE_DIR/summary.json" <<JSON
{
  "status": "passed",
  "generated_at": "$timestamp",
  "target_rehearsal_runner": "tests/e2e/scripts/run-gate5-target-rehearsal.sh",
  "evidence_contract_version": 1,
  "api_url": "$E2E_API_URL",
  "base_url": "$E2E_BASE_URL",
  "supabase_url": "$E2E_SUPABASE_URL",
  "provider": "$E2E_GOLDEN_PROVIDER",
  "github_app_required": "$E2E_REQUIRE_GITHUB_APP",
  "golden_paths_enabled": "$E2E_ENABLE_GOLDEN_PATHS",
  "golden_backpressure_enabled": "$E2E_GOLDEN_BACKPRESSURE",
  "local_docker_golden_enabled": "$E2E_GOLDEN_LOCAL_DOCKER",
  "slos_enforced": "$E2E_ENFORCE_SLOS",
  "managed_observability_required": "${GATE5_REQUIRE_MANAGED_OBSERVABILITY:-1}",
  "no_active_legacy_required": "${GATE5_REQUIRE_NO_ACTIVE_LEGACY:-1}",
  "preflight_only": false,
  "destructive_tests_run": true,
  "observability_probe": {
    "request_id": "$probe_request_id",
    "trace_id": "$probe_trace_id",
    "incoming_traceparent": "$probe_traceparent",
    "response_traceparent": "$probe_response_traceparent",
    "expected_log_fields": ["request_id", "trace_id"],
    "expected_trace_fields": ["traceId", "parentSpanId", "service.name"]
  },
  "evidence_dir": "$EVIDENCE_DIR",
  "spec_sections": ["0.2", "3", "5", "7", "10", "12"],
  "artifacts": {
    "health": "health.json",
    "health_headers": "health.headers",
    "ops_overview": "ops-overview.json",
    "playwright_report": "playwright-report.json",
    "run_log": "run.log"
  }
}
JSON

echo "[gate5] Target rehearsal passed"
echo "[gate5] Evidence captured in $EVIDENCE_DIR"
