#!/usr/bin/env bash
# Print the sign-in action from the newest auth email a preview sent.
#
#   preview-auth-email.sh <preview-origin> <email> [since-epoch-seconds]
#
# A preview delivers every auth email to its own Mailpit at
# <origin>/_mailpit. This prints the Supabase verify link, or the 6-digit
# code when the email carries no link. Polls for up to 60 s.
# Exit codes: 0 printed, 1 usage, 2 no email arrived.
set -euo pipefail

origin="${1:-}"
email="${2:-}"
since="${3:-0}"
if [ -z "$origin" ] || [ -z "$email" ]; then
  echo "usage: $0 <preview-origin> <email> [since-epoch-seconds]" >&2
  exit 1
fi
mailpit="${origin%/}/_mailpit/api/v1"

for _ in $(seq 1 60); do
  id="$(curl -fsS -G "${mailpit}/search" --data-urlencode "query=to:${email}" |
    jq -r --argjson since "$since" \
      '[.messages[]? | select((.Created | sub("\\.[0-9]+"; "") | fromdateiso8601) >= $since)]
       | sort_by(.Created) | last | .ID // empty')"
  if [ -n "$id" ]; then
    body="$(curl -fsS "${mailpit}/message/${id}" | jq -r '(.Text // "") + "\n" + (.HTML // "")' |
      sed 's/&amp;/\&/g')"
    link="$(printf '%s' "$body" | grep -oE 'https?://[^[:space:]<>"'"'"')]+' | grep -m1 '/auth/v1/verify?' || true)"
    if [ -n "$link" ]; then
      echo "$link"
      exit 0
    fi
    code="$(printf '%s' "$body" | grep -oE '(^|[^0-9])[0-9]{6}([^0-9]|$)' | grep -oE '[0-9]{6}' | head -1 || true)"
    if [ -n "$code" ]; then
      echo "$code"
      exit 0
    fi
  fi
  sleep 1
done
echo "no auth email for ${email} arrived at ${mailpit} within 60 s" >&2
exit 2
