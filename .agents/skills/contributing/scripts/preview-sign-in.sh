#!/usr/bin/env bash
# Sign a new synthetic user in to a preview, inside an agent-browser session.
#
#   preview-sign-in.sh <preview-origin> <agent-browser-session>
#
# Opens <origin>/auth, requests an email sign-in for pr-demo-<epoch>@example.test,
# reads the link or code from the preview's Mailpit, and completes it. Prints the
# email on success. The session stays open and signed in, ready to record.
# Exit codes: 0 signed in, 1 usage, 2 the sign-in did not complete.
set -euo pipefail

origin="${1:-}"
session="${2:-}"
if [ -z "$origin" ] || [ -z "$session" ]; then
  echo "usage: $0 <preview-origin> <agent-browser-session>" >&2
  exit 1
fi
origin="${origin%/}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ab() { agent-browser --session "$session" "$@" >/dev/null; }

email="pr-demo-$(date +%s)@example.test"
since="$(date +%s)"

ab open "$origin/auth"
ab wait --text "Welcome to Kortix"
# The form posts only after hydration (tests/e2e/specs/01-account-auth.spec.ts).
ab wait --fn "Boolean(window.__ENV_LOGGED__)"
ab find label "Email" fill "$email"
# Poll the page text rather than `wait --text` with a shorter AGENT_BROWSER_DEFAULT_TIMEOUT:
# a per-command AGENT_BROWSER_* env change relaunches the browser and loses the page.
sent=0
for _ in 1 2 3; do
  ab press Enter
  for _ in 1 2 3 4 5; do
    if [ "$(agent-browser --session "$session" eval 'document.body.innerText.includes("Check your email")' 2>/dev/null)" = true ]; then
      sent=1
      break 2
    fi
    sleep 1
  done
done
if [ "$sent" != 1 ]; then
  echo "the /auth form did not reach 'Check your email' for ${email}" >&2
  exit 2
fi

action="$("$here/preview-auth-email.sh" "$origin" "$email" "$since")"
case "$action" in
  http*) ab open "$action" ;;
  *) ab find label "Digit 1" fill "$action" ;;
esac

for _ in $(seq 1 60); do
  url="$(agent-browser --session "$session" get url 2>/dev/null || true)"
  case "$url" in
    "$origin"/auth*|"$origin/auth" | "") sleep 1 ;;
    "$origin"*)
      # Signed in once the app renders the account, not merely once /auth is left.
      for _ in $(seq 1 30); do
        if [ "$(agent-browser --session "$session" eval "document.body.innerText.includes('${email}')" 2>/dev/null)" = true ]; then
          echo "$email"
          exit 0
        fi
        sleep 1
      done
      echo "left /auth but the app never showed ${email} as signed in" >&2
      exit 2
      ;;
    *) sleep 1 ;;
  esac
done
echo "sign-in for ${email} did not leave /auth within 60 s (last URL: ${url:-none})" >&2
exit 2
