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
for _ in 1 2 3; do
  ab press Enter
  if AGENT_BROWSER_DEFAULT_TIMEOUT=5000 agent-browser --session "$session" wait --text "Check your email" >/dev/null 2>&1; then
    break
  fi
done

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
      echo "$email"
      exit 0
      ;;
    *) sleep 1 ;;
  esac
done
echo "sign-in for ${email} did not leave /auth within 60 s (last URL: ${url:-none})" >&2
exit 2
