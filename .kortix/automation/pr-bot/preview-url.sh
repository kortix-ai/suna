#!/usr/bin/env bash
# Mint a one-click preview URL for a port running inside THIS session's
# sandbox, and print it on stdout. The reviewer opens the URL and the
# Kortix proxy forwards to the sandbox port (the dev server must already
# be listening on that port).
#
# Usage:  preview-url.sh <port> [label]
#   port    the port your dev server listens on inside the sandbox
#   label   optional human label stored with the share link
#
# Prefers a short-lived shared link (POST /v1/p/share) so the URL carries
# its own ?token and a teammate can open it without logging in. Falls back
# to the bare deterministic proxy URL (which requires the opener to be
# authenticated) if the share endpoint is unavailable.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PORT="${1:?usage: preview-url.sh <port> [label]}"
LABEL="${2:-preview :$PORT}"
TTL="${PREVIEW_TTL:-7d}"

ORIGIN="$(kortix_api_origin)"
SANDBOX="$(kortix_sandbox_id)"

# /v1/p/share gates on canAccessPreviewSandbox(userId/accountId) — so it needs a
# USER/PROJECT principal, NOT the sandbox service key. KORTIX_CLI_TOKEN (the
# project PAT) resolves to the owning account; KORTIX_TOKEN (sandbox key) is
# rejected here. Use the CLI token first (this was the "share unavailable" bug).
SHARE_TOKEN="${KORTIX_CLI_TOKEN:-${KORTIX_TOKEN:-}}"

share() {
  [ -n "$SHARE_TOKEN" ] || return 1
  curl -fsS -m 15 -X POST \
    -H "Authorization: Bearer ${SHARE_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"sandbox_id\":\"${SANDBOX}\",\"port\":${PORT},\"ttl\":\"${TTL}\",\"label\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$LABEL")}" \
    "${KORTIX_API_URL}/p/share" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("url",""))' 2>/dev/null
}

URL="$(share || true)"
if [ -z "$URL" ]; then
  log "share endpoint unavailable — emitting bare proxy URL (opener must be authed)"
  URL="${ORIGIN}/v1/p/${SANDBOX}/${PORT}"
fi

printf '%s\n' "$URL"
