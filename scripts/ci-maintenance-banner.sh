#!/usr/bin/env bash
#
# ci-maintenance-banner.sh — flip the system-wide maintenance banner on/off
# around a production rollout, from CI.
#
# Called by .github/workflows/deploy-prod.yml:
#   on  <version>   activate a non-dismissible CRITICAL banner ("new version
#                   rolling out, may be briefly unavailable") at the START of the
#                   rollout, so every user sees it for the whole window.
#   off             clear it (level none) — called when the run ends, whatever its
#                   result (success, failure or cancel).
#
# It writes the same dual database + Vercel Edge Config state the admin console
# uses, via `PUT /api/maintenance` on the web app.
#
# SAFETY — it never clobbers a human-set incident banner. Since the rollout banner
# is itself `critical` now, "ours" is identified by its title, not its level:
#   * `on`  refuses to override an active `critical`/`blocking` incident whose
#           title is NOT our rollout title (a real, human-set incident).
#   * `off` only clears the banner if it is STILL our rollout banner (same title
#           and `critical` level); if an admin changed it mid-rollout, we leave it.
#
# Env:
#   MAINTENANCE_TOKEN     (required) platform-admin bearer
#   MAINTENANCE_URL       (optional) full endpoint, default https://kortix.com/api/maintenance
#
# Best-effort: the caller runs this with continue-on-error so a banner hiccup
# never fails the release.

set -euo pipefail

ENDPOINT="${MAINTENANCE_URL:-https://kortix.com/api/maintenance}"
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
  local attempt
  for attempt in 1 2 3 4; do
    if curl -fsS --max-time 15 -X PUT "$ENDPOINT" \
      -H "Authorization: Bearer ${MAINTENANCE_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body" >/dev/null; then
      return 0
    fi
    echo "::warning::Banner PUT attempt ${attempt}/4 failed." >&2
    [[ "$attempt" -lt 4 ]] && sleep $((attempt * 5))
  done
  echo "::error::Maintenance banner PUT failed after 4 attempts. The banner may be stale: check ${ENDPOINT}." >&2
  return 1
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
    # Read the state with retries. An unreachable endpoint is not "not ours":
    # log it loudly so a stale banner is visible in the run.
    state=""
    for attempt in 1 2 3 4; do
      state="$(curl -fsS --max-time 15 "$ENDPOINT" 2>/dev/null || true)"
      [[ -n "$state" ]] && break
      sleep $((attempt * 5))
    done
    if [[ -z "$state" ]]; then
      echo "::error::Maintenance endpoint ${ENDPOINT} unreachable after 4 attempts. The rollout banner may be stale." >&2
      exit 1
    fi
    level="$(jq -r '.level // empty' <<<"$state" 2>/dev/null || true)"
    title="$(jq -r '.title // empty' <<<"$state" 2>/dev/null || true)"
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
