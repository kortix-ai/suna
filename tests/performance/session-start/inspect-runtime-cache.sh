#!/usr/bin/env bash
#
# Inspect the OpenCode cache and process state inside sessions retained by
# bench-boot-attribution.ts. The script uses the same authenticated API proxy
# as a client. It does not require direct provider credentials.
#
# Required:
#   BENCH_TOKEN       JWT or PAT for BENCH_API
#   BENCH_DB_URL      database URL for BENCH_API
#
# Optional:
#   BENCH_API         API origin without /v1 (default: http://localhost:8008)
#   BENCH_RESULT      retained-session benchmark JSON
#   BENCH_OUT         JSON output path
#
# The source benchmark must use BENCH_KEEP=1. Delete the retained sessions and
# project after inspection.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BENCH_API="${BENCH_API:-http://localhost:8008}"
BENCH_API="${BENCH_API%/}"
BENCH_RESULT="${BENCH_RESULT:-$SCRIPT_DIR/results/$(date -u +%F)/local-baked-acp-a-b.json}"
BENCH_OUT="${BENCH_OUT:-${BENCH_RESULT%.json}-cache-inspection.json}"

: "${BENCH_TOKEN:?BENCH_TOKEN is required}"
: "${BENCH_DB_URL:?BENCH_DB_URL is required}"

if [ ! -f "$BENCH_RESULT" ]; then
  printf 'benchmark result not found: %s\n' "$BENCH_RESULT" >&2
  exit 1
fi

inspect_command='
{
  printf "HOME=%s\n" "$HOME"
  id
  stat -c "%n|%s|%y" /home/kortix/.local/share/opencode/opencode.db*
  printf "LOGS\n"
  find /home/kortix/.local/share/opencode/log -maxdepth 1 -type f \
    -printf "%f|%s|%TY-%Tm-%TdT%TH:%TM:%TS%Tz\n" | sort
  printf "PROCESSES\n"
  ps -eo pid,lstart,args | grep "[o]pencode"
} > /tmp/kortix-runtime-cache-inspection.txt 2>&1
latest_log="$(
  find /home/kortix/.local/share/opencode/log -maxdepth 1 -type f \
    -printf "%T@ %p\n" | sort -n | tail -1 | cut -d" " -f2-
)"
if [ -n "$latest_log" ]; then
  tail -200 "$latest_log" > /tmp/kortix-runtime-cache-latest.log
else
  : > /tmp/kortix-runtime-cache-latest.log
fi
'

tmp_results="$(mktemp)"
trap 'rm -f "$tmp_results"' EXIT
printf '[]\n' > "$tmp_results"

while IFS=$'\t' read -r target session_id; do
  row="$(
    psql "$BENCH_DB_URL" -AtF $'\t' -c \
      "select provider::text, external_id
       from kortix.session_sandboxes
       where sandbox_id = '$session_id'::uuid
       limit 1"
  )"
  provider="${row%%$'\t'*}"
  external_id="${row#*$'\t'}"
  if [ -z "$provider" ] || [ -z "$external_id" ] || [ "$provider" = "$row" ]; then
    printf 'session has no provider runtime: %s\n' "$session_id" >&2
    exit 1
  fi

  pty_body="$(
    jq -cn \
      --arg command '/bin/bash' \
      --arg inspect_command "$inspect_command" \
      '{
        command:$command,
        args:["-lc",$inspect_command],
        cwd:"/workspace",
        title:"runtime-cache-inspection"
      }'
  )"
  http_code="$(
    curl -sS \
      -o /dev/null \
      -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer $BENCH_TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$pty_body" \
      "$BENCH_API/v1/p/$external_id/8000/kortix/pty"
  )"
  if [ "$http_code" != '200' ]; then
    printf 'PTY inspection failed: session=%s HTTP=%s\n' "$session_id" "$http_code" >&2
    exit 1
  fi

  sleep 1
  inspection="$(
    curl -fsS \
      -G \
      -H "Authorization: Bearer $BENCH_TOKEN" \
      --data-urlencode 'path=/tmp/kortix-runtime-cache-inspection.txt' \
      "$BENCH_API/v1/p/$external_id/8000/file/content" |
      jq -r '.content'
  )"
  log_tail="$(
    curl -fsS \
      -G \
      -H "Authorization: Bearer $BENCH_TOKEN" \
      --data-urlencode 'path=/tmp/kortix-runtime-cache-latest.log' \
      "$BENCH_API/v1/p/$external_id/8000/file/content" |
      jq -r '.content'
  )"

  next_results="$(mktemp)"
  jq \
    --arg target "$target" \
    --arg session_id "$session_id" \
    --arg provider "$provider" \
    --arg external_id "$external_id" \
    --arg inspection "$inspection" \
    --arg log_tail "$log_tail" \
    '. + [{
      target:$target,
      sessionId:$session_id,
      provider:$provider,
      externalId:$external_id,
      inspection:$inspection,
      openCodeLogTail:$log_tail
    }]' \
    "$tmp_results" > "$next_results"
  mv "$next_results" "$tmp_results"
  printf 'inspected %s session %s\n' "$provider" "$session_id" >&2
done < <(jq -r '.boots[] | select(.sessionId != null) | [.target,.sessionId] | @tsv' "$BENCH_RESULT")

mkdir -p "$(dirname "$BENCH_OUT")"
jq -n \
  --arg generated_at "$(date -u +%FT%TZ)" \
  --arg source "$BENCH_RESULT" \
  --slurpfile sessions "$tmp_results" \
  '{generatedAt:$generated_at,source:$source,sessions:$sessions[0]}' > "$BENCH_OUT"
printf 'raw → %s\n' "$BENCH_OUT" >&2
