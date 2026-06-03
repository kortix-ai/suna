#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${KORTIX_SELF_HOST_INSTANCE:-${KORTIX_E2E_INSTANCE:-default}}"
CONFIG_DIR="${KORTIX_SELF_HOST_CONFIG_DIR:-$HOME/.config/kortix/self-host/$INSTANCE}"
ENV_FILE="${E2E_ENV_FILE:-$CONFIG_DIR/.env}"

echo "Testing auth flow..."

if [ ! -f "$ENV_FILE" ]; then
    echo "Missing self-host env file: $ENV_FILE"
    echo "Start the stack first with: kortix self-host start --local --yes"
    exit 1
fi

env_value() {
    grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true
}

FRONTEND_URL="${E2E_BASE_URL:-$(env_value PUBLIC_URL)}"
SUPABASE_URL="${E2E_SUPABASE_URL:-$(env_value SUPABASE_PUBLIC_URL)}"
OWNER_EMAIL="${E2E_OWNER_EMAIL:-test-e2e@kortix.ai}"
OWNER_PASSWORD="${E2E_OWNER_PASSWORD:-e2e-testpass-123}"
ANON_KEY="$(env_value SUPABASE_ANON_KEY)"

if [ -z "$FRONTEND_URL" ] || [ -z "$SUPABASE_URL" ] || [ -z "$ANON_KEY" ]; then
    echo "Self-host env is missing PUBLIC_URL, SUPABASE_PUBLIC_URL, or SUPABASE_ANON_KEY"
    exit 1
fi

echo "Signing in as $OWNER_EMAIL..."

# Sign in
SESSION=$(curl -sf "$SUPABASE_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}")

# Create cookie
COOKIE=$(python3 -c "
import json, urllib.parse
s = json.loads('''$SESSION''')
print(urllib.parse.quote(json.dumps(s, separators=(',', ':')), safe=''))
")

# Test project shell
echo "Testing /projects access..."
HTTP_CODE=$(curl -s "$FRONTEND_URL/projects" \
    -H "Cookie: sb-kortix-auth-token.0=$COOKIE" \
    -o /dev/null -w "%{http_code}")

if [ "$HTTP_CODE" = "200" ]; then
    echo "Auth flow working"
    exit 0
else
    echo "Auth failed - HTTP $HTTP_CODE"
    exit 1
fi
