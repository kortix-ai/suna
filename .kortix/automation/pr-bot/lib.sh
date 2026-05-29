#!/usr/bin/env bash
# Shared helpers for the PR-bot automation. Source this from the other
# scripts: `source "$(dirname "$0")/lib.sh"`.
#
# The PR-bot agent runs inside a Kortix session sandbox spawned by a
# webhook trigger. These helpers bridge the gap between that sandbox and
# the GitHub repo + the Kortix preview proxy.
set -euo pipefail

# ── Logging ────────────────────────────────────────────────────────────
log()  { printf '\033[2m[pr-bot]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[pr-bot] %s\033[0m\n' "$*" >&2; exit 1; }

# ── Required environment ───────────────────────────────────────────────
# REPO        e.g. kortix-ai/suna           (from {{ body.repository.full_name }})
# PR_NUMBER   e.g. 1234                      (from {{ body.number }})
# PR_HEAD_REF e.g. feat/foo                  (from {{ body.pull_request.head.ref }})
# PR_BASE_REF e.g. newer-kortix              (from {{ body.pull_request.base.ref }})
# GH_TOKEN    GitHub token (project secret)  — repo contents + PR write scope
#
# Kortix-injected (present automatically in every session sandbox):
# KORTIX_API_URL, KORTIX_PROJECT_ID, KORTIX_SESSION_ID, KORTIX_TOKEN,
# KORTIX_CLI_TOKEN
require_env() {
  local missing=()
  for v in "$@"; do
    [ -n "${!v:-}" ] || missing+=("$v")
  done
  [ ${#missing[@]} -eq 0 ] || die "missing required env: ${missing[*]}"
}

# Origin of the Kortix API without the trailing /v1 (proxy lives at /v1/p).
kortix_api_origin() {
  require_env KORTIX_API_URL
  printf '%s' "${KORTIX_API_URL%/v1}"
}

# The session's externally-addressable sandbox id (used in proxy URLs).
# Cached after first lookup.
_KORTIX_SANDBOX_ID=""
kortix_sandbox_id() {
  [ -z "$_KORTIX_SANDBOX_ID" ] || { printf '%s' "$_KORTIX_SANDBOX_ID"; return; }
  require_env KORTIX_API_URL KORTIX_PROJECT_ID KORTIX_SESSION_ID KORTIX_CLI_TOKEN
  local resp
  resp=$(curl -fsS -m 15 \
    -H "Authorization: Bearer ${KORTIX_CLI_TOKEN}" \
    "${KORTIX_API_URL}/projects/${KORTIX_PROJECT_ID}/sessions/${KORTIX_SESSION_ID}") \
    || die "could not fetch session (is KORTIX_CLI_TOKEN valid?)"
  _KORTIX_SANDBOX_ID=$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sandbox_id",""))')
  [ -n "$_KORTIX_SANDBOX_ID" ] || die "session has no sandbox_id yet (not booted?)"
  printf '%s' "$_KORTIX_SANDBOX_ID"
}
