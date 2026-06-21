#!/usr/bin/env bash
# Durability engine for the Allure portal.
#
# Carries trend history across runs and archives everything to S3 (versioned),
# so results are never lost and the hosted portal (qa.kortix.com) always serves
# the latest report. Degrades gracefully to generate-only when S3 isn't
# configured (local dev) so the same command works everywhere.
#
# Env:
#   S3_BUCKET        target bucket (e.g. kortix-qa-reports). Unset = local-only.
#   S3_PREFIX        key prefix (default: reports)
#   RESULTS_DIR      allure-results input (default: test-results/allure-results)
#   REPORT_DIR       generated report output (default: test-results/allure-report)
#   HISTORY_FILE     trend history jsonl (default: test-results/history.jsonl)
#   RUN_ID           archive id (default: git short sha, else timestamp)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

S3_BUCKET="${S3_BUCKET:-}"
S3_PREFIX="${S3_PREFIX:-reports}"
RESULTS_DIR="${RESULTS_DIR:-test-results/allure-results}"
REPORT_DIR="${REPORT_DIR:-test-results/allure-report}"
HISTORY_FILE="${HISTORY_FILE:-test-results/history.jsonl}"
RUN_ID="${RUN_ID:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

log() { printf '\033[0;36m[publish]\033[0m %s\n' "$*"; }

if [ ! -d "$RESULTS_DIR" ] || [ -z "$(ls -A "$RESULTS_DIR" 2>/dev/null)" ]; then
  msg="no allure-results in $RESULTS_DIR — run a suite + 'ke2e allure --from <results.json>' first"
  if [ -n "${CI:-}" ]; then echo "::warning::${msg}; skipping publish"; exit 0; fi
  echo "$msg" >&2
  exit 1
fi

s3_enabled=0
if [ -n "$S3_BUCKET" ] && command -v aws >/dev/null 2>&1; then
  s3_enabled=1
fi

if [ "$s3_enabled" = "1" ]; then
  log "pulling trend history from s3://$S3_BUCKET/$S3_PREFIX/history/"
  aws s3 cp "s3://$S3_BUCKET/$S3_PREFIX/history/history.jsonl" "$HISTORY_FILE" 2>/dev/null \
    && log "history restored ($(wc -l < "$HISTORY_FILE" | tr -d ' ') entries)" \
    || log "no prior history (first run)"
fi

log "generating report (history-carried) → $REPORT_DIR"
npx --no-install allure generate "$RESULTS_DIR"

if [ "$s3_enabled" != "1" ]; then
  log "S3 not configured — generated locally only. Open $REPORT_DIR/index.html"
  exit 0
fi

log "archiving run $RUN_ID to s3://$S3_BUCKET/$S3_PREFIX/"
aws s3 sync "$RESULTS_DIR" "s3://$S3_BUCKET/$S3_PREFIX/runs/$RUN_ID/results/" --only-show-errors
aws s3 sync "$REPORT_DIR" "s3://$S3_BUCKET/$S3_PREFIX/runs/$RUN_ID/report/" --only-show-errors

log "publishing as latest (what the portal serves)"
aws s3 sync "$REPORT_DIR" "s3://$S3_BUCKET/$S3_PREFIX/latest/" --delete --only-show-errors

if [ -f "$HISTORY_FILE" ]; then
  log "persisting updated trend history"
  aws s3 cp "$HISTORY_FILE" "s3://$S3_BUCKET/$S3_PREFIX/history/history.jsonl" --only-show-errors
fi

log "done — portal will sync s3://$S3_BUCKET/$S3_PREFIX/latest/ within its refresh interval"
