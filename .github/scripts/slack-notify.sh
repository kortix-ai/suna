#!/usr/bin/env bash
set -uo pipefail

# Posts a Block Kit message via Slack chat.postMessage. Reused by release and
# incident workflows. Skips gracefully when SLACK_BOT_TOKEN / SLACK_CHANNEL are
# unset so it never fails a run just because Slack is not configured.
#
# Env: SLACK_BOT_TOKEN, SLACK_CHANNEL (required to send)
#      HEADER (plain_text), BODY (mrkdwn), FIELDS (newline-separated mrkdwn pairs,
#      optional), RUN_URL (optional button), COLOR_EMOJI (optional, prefixes header)

if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_CHANNEL:-}" ]; then
  echo "::notice::SLACK_BOT_TOKEN / SLACK_CHANNEL not set — skipping Slack."
  exit 0
fi

HEADER="${COLOR_EMOJI:-}${HEADER:-Notification}"
BODY="$(printf '%s' "${BODY:-}" | head -c 2800)"

fields_json='[]'
if [ -n "${FIELDS:-}" ]; then
  fields_json="$(printf '%s\n' "$FIELDS" | jq -R 'select(length>0) | { type:"mrkdwn", text:. }' | jq -s '.')"
fi

actions_json='[]'
if [ -n "${RUN_URL:-}" ]; then
  actions_json="$(jq -n --arg url "$RUN_URL" \
    '[ { type:"actions", elements:[ { type:"button", text:{ type:"plain_text", text:"🔧 Pipeline", emoji:true }, url:$url } ] } ]')"
fi

payload="$(jq -n \
  --arg channel "$SLACK_CHANNEL" \
  --arg header "$HEADER" \
  --arg body "$BODY" \
  --argjson fields "$fields_json" \
  --argjson actions "$actions_json" \
  '{
     channel: $channel,
     text: $header,
     blocks: ([
       { type:"header", text:{ type:"plain_text", text:$header, emoji:true } }
     ]
     + (if $body == "" then [] else [ { type:"section", text:{ type:"mrkdwn", text:$body } } ] end)
     + (if ($fields | length) == 0 then [] else [ { type:"section", fields:$fields } ] end)
     + $actions)
   }')"

for attempt in 1 2 3 4 5; do
  resp="$(curl -sS --max-time 30 \
    -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
    -H "Content-type: application/json; charset=utf-8" \
    --data "$payload" \
    https://slack.com/api/chat.postMessage || true)"
  ok="$(printf '%s' "$resp" | jq -r '.ok // false' 2>/dev/null || echo false)"
  if [ "$ok" = "true" ]; then
    echo "✓ Slack notified (${SLACK_CHANNEL})"; exit 0
  fi
  err="$(printf '%s' "$resp" | jq -r '.error // "no_response"' 2>/dev/null || echo no_response)"
  echo "::warning::Slack attempt ${attempt}/5 failed: ${err}"
  case "$err" in
    invalid_auth|not_authed|account_inactive|token_revoked|channel_not_found|not_in_channel|is_archived|missing_scope)
      echo "::error::Slack permanent error '${err}'. Check SLACK_BOT_TOKEN (xoxb + chat:write), SLACK_CHANNEL (id), bot invited."
      exit 1 ;;
  esac
  sleep $((attempt * 3))
done
echo "::error::Slack failed after 5 attempts (last: ${err})."; exit 1
