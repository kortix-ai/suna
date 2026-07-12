#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API="${E2E_API_URL:-http://localhost:19008/v1}"
LOG_DIR="${E2E_ACP_LOG_DIR:-$ROOT/test-results/acp-all-harnesses}"
mkdir -p "$LOG_DIR"

curl --fail --silent --show-error "$API/health" >/dev/null
if [[ -z "${E2E_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:-}}" || -z "${E2E_ANON_KEY:-${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}}" ]]; then
  supabase_status="$(cd "$ROOT" && pnpm exec supabase status -o json 2>/dev/null)"
  export E2E_SERVICE_ROLE_KEY="$(jq -r '.SERVICE_ROLE_KEY // empty' <<<"$supabase_status")"
  export E2E_ANON_KEY="$(jq -r '.ANON_KEY // empty' <<<"$supabase_status")"
fi
: "${E2E_SERVICE_ROLE_KEY:-${SUPABASE_SERVICE_ROLE_KEY:?Supabase service-role key is required}}"
: "${E2E_ANON_KEY:-${NEXT_PUBLIC_SUPABASE_ANON_KEY:?Supabase anon key is required}}"

harnesses=(opencode claude codex pi)
pids=()
for harness in "${harnesses[@]}"; do
  log="$LOG_DIR/$harness.log"
  echo "[acp-all] starting $harness (log: $log)"
  E2E_ACP_HARNESS="$harness" bun "$ROOT/tests/e2e/scripts/acp-session-smoke.ts" >"$log" 2>&1 &
  pids+=("$!")
done

failed=0
for index in "${!harnesses[@]}"; do
  harness="${harnesses[$index]}"
  pid="${pids[$index]}"
  if wait "$pid"; then
    tail -n 1 "$LOG_DIR/$harness.log"
  else
    failed=1
    echo "[acp-all] FAIL $harness" >&2
    tail -n 80 "$LOG_DIR/$harness.log" >&2
  fi
done

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi
echo "[acp-all] PASS all harnesses"
