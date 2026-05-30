#!/usr/bin/env bash
# Mint a public, root-served preview URL for a port in THIS sandbox and print
# it on stdout — the standard way the PR-bot links a running preview.
#
# Uses Daytona's port preview-url API: GET {server}/sandbox/{id}/ports/{port}/
# preview-url → { url, token }. We append the token as ?DAYTONA_SANDBOX_AUTH_KEY
# so the link is browser-clickable AND served at the origin root (so SPA/Next
# assets resolve — the Kortix path proxy `/v1/p/{id}/{port}` would break them).
#
# The sandbox already carries its own Daytona context in env
# (DAYTONA_SANDBOX_ID / DAYTONA_SERVER_URL / DAYTONA_API_KEY), so no Kortix
# token juggling is needed.
#
# Usage:  preview-url.sh <port> [label]
set -euo pipefail

PORT="${1:?usage: preview-url.sh <port> [label]}"

SBID="${DAYTONA_SANDBOX_ID:-}"
DURL="${DAYTONA_SERVER_URL:-}"
DKEY="${DAYTONA_API_KEY:-}"
if [ -z "$SBID" ] || [ -z "$DURL" ] || [ -z "$DKEY" ]; then
  echo "preview-url: missing DAYTONA_SANDBOX_ID / DAYTONA_SERVER_URL / DAYTONA_API_KEY in env" >&2
  exit 1
fi

resp="$(curl -fsS -m 20 "${DURL%/}/sandbox/${SBID}/ports/${PORT}/preview-url" \
  -H "Authorization: Bearer ${DKEY}" 2>/dev/null)" || {
  echo "preview-url: Daytona preview-url request failed for port ${PORT}" >&2
  exit 1
}

url="$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("url",""))' 2>/dev/null)"
token="$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))' 2>/dev/null)"

if [ -z "$url" ]; then
  echo "preview-url: Daytona returned no url for port ${PORT} (is the port open?)" >&2
  exit 1
fi

if [ -n "$token" ]; then
  printf '%s/?DAYTONA_SANDBOX_AUTH_KEY=%s\n' "${url%/}" "$token"
else
  printf '%s\n' "$url"
fi
