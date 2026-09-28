#!/usr/bin/env bash
# Subscribe a preview-sign-in.sh account to a real Stripe test-mode plan, so
# it is entitled to Kortix-managed models before you record a demo.
#
#   preview-subscribe.sh <preview-origin> <agent-browser-session> [tier_key]
#
# A fresh preview account is free tier and gets no managed models — by design
# (apps/api/src/billing/services/tiers.ts: accountIsFreeTierForModels denies
# managed models to every unpaid tier, in every environment, since commit
# 406eb5e9ac). Its model picker is then empty and an agent turn has nothing to
# answer with. preview-environments.md already names the fix ("subscribe with
# a Stripe test card"); this script does it for you, against the account
# preview-sign-in.sh just signed in, using the same test-mode Stripe secret
# every preview is already tested with.
#
# Run this right after preview-sign-in.sh and before you record.
# Exit codes: 0 subscribed, 1 usage, 2 no signed-in session found on that
# agent-browser session, 3 the subscribe call failed.
set -euo pipefail

origin="${1:-}"
session="${2:-}"
tier="${3:-pro}"
if [ -z "$origin" ] || [ -z "$session" ]; then
  echo "usage: $0 <preview-origin> <agent-browser-session> [tier_key]" >&2
  exit 1
fi
origin="${origin%/}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"

# Pull the signed-in session out of the browser's Supabase auth cookie
# (@supabase/ssr format: base64-<base64url(JSON)>, chunked past ~3180 bytes —
# tests/e2e/helpers/session-auth.ts documents the same shape). The preview
# origin is never localhost, so the cookie name carries no port suffix
# (apps/web/src/lib/supabase/constants.ts).
extract_js='(() => {
  const name = "sb-kortix-auth-token";
  const parts = document.cookie.split("; ").filter((c) => c.startsWith(name + "=") || c.startsWith(name + "."));
  if (parts.length === 0) return JSON.stringify({ error: "no auth cookie" });
  parts.sort((a, b) => {
    const ai = a.includes(".") && !a.startsWith(name + "=") ? parseInt(a.split(".").pop(), 10) : -1;
    const bi = b.includes(".") && !b.startsWith(name + "=") ? parseInt(b.split(".").pop(), 10) : -1;
    return ai - bi;
  });
  const raw = decodeURIComponent(parts.map((c) => c.slice(c.indexOf("=") + 1)).join(""));
  const b64 = raw.replace(/^base64-/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const session = JSON.parse(atob(padded));
  return JSON.stringify({ access_token: session.access_token, account_id: session.user.id });
})()'

session_json="$(agent-browser --session "$session" eval "$extract_js" 2>/dev/null || true)"
# agent-browser prints the JS return value already JSON-encoded (a quoted
# string containing our JSON); unwrap it if jq's -r round-trip left it doubled.
access_token="$(printf '%s' "$session_json" | jq -r 'fromjson? // . | .access_token // empty' 2>/dev/null || true)"
account_id="$(printf '%s' "$session_json" | jq -r 'fromjson? // . | .account_id // empty' 2>/dev/null || true)"
if [ -z "$access_token" ] || [ -z "$account_id" ]; then
  echo "no signed-in session on ${session}; run preview-sign-in.sh first (${session_json})" >&2
  exit 2
fi

# Same test-mode Stripe secret already on the preview runtime allowlist
# (KE2E_STRIPE_SECRET_KEY / KE2E_STRIPE_WEBHOOK_SECRET —
# tests/src/core/preview-stack.ts). Not a new secret: apps/api/.env.staging is
# the repo's own dotenvx-encrypted mirror of the same value.
stripe_secret_key="$(dotenvx get STRIPE_SECRET_KEY -f "$repo/apps/api/.env.staging")"
stripe_webhook_secret="$(dotenvx get STRIPE_WEBHOOK_SECRET -f "$repo/apps/api/.env.staging")"

if ! STRIPE_SECRET_KEY="$stripe_secret_key" STRIPE_WEBHOOK_SECRET="$stripe_webhook_secret" \
  bun run "$here/preview-subscribe.ts" "$origin" "$access_token" "$account_id" "$tier"; then
  echo "subscribe failed for account ${account_id} on ${origin}" >&2
  exit 3
fi
