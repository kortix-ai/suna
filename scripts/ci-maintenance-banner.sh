#!/usr/bin/env bash
#
# ci-maintenance-banner.sh — flip the system-wide maintenance banner on/off
# around a production rollout, from CI.
#
# Called by .github/workflows/deploy-prod.yml:
#   on  <version>   activate a non-dismissible CRITICAL banner ("new version
#                   rolling out, may be briefly unavailable") at the START of the
#                   rollout, so every user sees it for the whole window.
#   off             clear it (level none) — only called AFTER the rollout is green.
#
# It writes the same maintenance config the admin console does, via
# `PUT /v1/system/maintenance` (platform-admin bearer required).
#
# SAFETY — it never clobbers a human-set incident banner. Since the rollout banner
# is itself `critical` now, "ours" is identified by its title, not its level:
#   * `on`  refuses to override an active `critical`/`blocking` incident whose
#           title is NOT our rollout title (a real, human-set incident).
#   * `off` only clears the banner if it is STILL our rollout banner (same title
#           and `critical` level); if an admin changed it mid-rollout, we leave it.
#
# Env:
#   MAINTENANCE_TOKEN     (required) platform-admin bearer (kortix_pat_/kortix_sa_ or JWT)
#   MAINTENANCE_API_BASE  (optional) API base incl. /v1, default https://api.kortix.com/v1
#
# Best-effort: the caller runs this with continue-on-error so a banner hiccup
# never fails the release.

set -euo pipefail

API_BASE="${MAINTENANCE_API_BASE:-https://api.kortix.com/v1}"
ENDPOINT="${API_BASE%/}/system/maintenance"
ROLLOUT_TITLE="Release in progress"

CMD="${1:-}"

if [[ -z "${MAINTENANCE_TOKEN:-}" ]]; then
  echo "MAINTENANCE_TOKEN is not set — skipping maintenance banner ($CMD)." >&2
  exit 0
fi

get_field() {
  # $1 = jq field expression; prints current value (empty on any failure)
  curl -fsS --max-time 15 "$ENDPOINT" 2>/dev/null | jq -r "$1 // empty" 2>/dev/null || true
}

put() {
  # $1 level  $2 title  $3 message
  local body
  body="$(jq -n --arg l "$1" --arg t "$2" --arg m "$3" \
    '{level:$l, title:$t, message:$m, startTime:null, endTime:null}')"
  curl -fsS --max-time 15 -X PUT "$ENDPOINT" \
    -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$body" >/dev/null
}

case "$CMD" in
  on)
    version="${2:-}"
    level="$(get_field '.level')"
    level="${level:-none}"
    title="$(get_field '.title')"
    # Never override a human-set incident. The rollout banner is itself `critical`
    # now, so "ours" is identified by title — skip only when a critical/blocking
    # banner with a DIFFERENT title (a real incident) is up.
    if [[ ( "$level" == "critical" || "$level" == "blocking" ) && "$title" != "$ROLLOUT_TITLE" ]]; then
      echo "An active incident banner ($level: '${title}') is up — leaving it in place, not showing the rollout notice."
      exit 0
    fi
    msg="Deploying a new version — Kortix may be briefly unavailable."
    [[ -n "$version" ]] && msg="Deploying ${version} — Kortix may be briefly unavailable."
    put "critical" "$ROLLOUT_TITLE" "$msg"
    echo "Rollout critical banner activated${version:+ for $version}."
    ;;
  off)
    level="$(get_field '.level')"
    title="$(get_field '.title')"
    if [[ "$level" == "critical" && "$title" == "$ROLLOUT_TITLE" ]]; then
      put "none" "" ""
      echo "Rollout banner cleared."
    else
      echo "Current banner (level='${level:-none}', title='${title:-}') is not the rollout banner — leaving it as-is."
    fi
    ;;
  *)
    echo "usage: $0 on <version> | off" >&2
    exit 2
    ;;
esac
