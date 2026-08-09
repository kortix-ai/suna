#!/bin/sh
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix Frontend — Docker Entrypoint                                       ║
# ║                                                                            ║
# ║  Rewrites baked-in NEXT_PUBLIC_ values in the Next.js bundle at startup.   ║
# ║                                                                            ║
# ║  Next.js inlines NEXT_PUBLIC_ env vars at BUILD TIME into both server      ║
# ║  chunks and client (static) JS. The build uses well-known placeholder      ║
# ║  values (see build-local-images.sh):                                       ║
# ║                                                                            ║
# ║    NEXT_PUBLIC_SUPABASE_URL      = https://placeholder.supabase.co         ║
# ║    NEXT_PUBLIC_SUPABASE_ANON_KEY = local-build-placeholder-anon-key        ║
# ║    NEXT_PUBLIC_BACKEND_URL       = http://localhost:8008/v1                 ║
# ║    NEXT_PUBLIC_BILLING_ENABLED   = false                                   ║
# ║                                                                            ║
# ║  At container startup, this script replaces those placeholders with the    ║
# ║  actual runtime env vars from docker-compose.                              ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -e

# ECS injects the web profile as one Secrets Manager JSON document. Expand it
# in memory before reading any runtime values. Explicit task-definition values
# win. Do not write the decrypted profile to disk or print its values.
if [ -n "${KORTIX_ENV_JSON:-}" ]; then
  eval "$(node /hydrate-environment-secret.mjs)"
  unset KORTIX_ENV_JSON
fi

BUNDLE_DIR="/app/apps/web/.next"

# ── Well-known build-time placeholders (must match build-local-images.sh) ──────
BAKED_SUPABASE_URL="https://placeholder.supabase.co"
BAKED_ANON_KEY="local-build-placeholder-anon-key"
BAKED_BACKEND_URL="http://localhost:8008/v1"
BAKED_BACKEND_HOST="http://localhost:8008"

# Also handle local dev builds that may have localhost:54321 (Supabase CLI default)
# or 127.0.0.1:54321 baked in instead of the placeholder
DEV_SUPABASE_URLS="127.0.0.1:54321 localhost:54321"

# ── Runtime target values from docker-compose env ─────────────────────────────
# Support both NEXT_PUBLIC_* (legacy) and KORTIX_PUBLIC_* (current) naming.
RUNTIME_SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-${KORTIX_PUBLIC_SUPABASE_URL:-}}"
RUNTIME_ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-${KORTIX_PUBLIC_SUPABASE_ANON_KEY:-}}"
RUNTIME_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-${KORTIX_PUBLIC_BACKEND_URL:-}}"
RUNTIME_BILLING="${NEXT_PUBLIC_BILLING_ENABLED:-${KORTIX_PUBLIC_BILLING_ENABLED:-false}}"

# Derive backend host (strip /v1 suffix)
RUNTIME_BACKEND_HOST=""
if [ -n "$RUNTIME_BACKEND_URL" ]; then
  RUNTIME_BACKEND_HOST=$(echo "${RUNTIME_BACKEND_URL%/}" | sed 's|/v1$||')
fi

# ── Build sed rewrite script ──────────────────────────────────────────────────
SED_SCRIPT=$(mktemp)
needs_rewrite=false

# Supabase URL (placeholder)
if [ -n "$RUNTIME_SUPABASE_URL" ] && [ "$RUNTIME_SUPABASE_URL" != "$BAKED_SUPABASE_URL" ]; then
  if grep -rq "$BAKED_SUPABASE_URL" "$BUNDLE_DIR" 2>/dev/null; then
    printf 's|%s|%s|g\n' "$BAKED_SUPABASE_URL" "$RUNTIME_SUPABASE_URL" >> "$SED_SCRIPT"
    needs_rewrite=true
    echo "[entrypoint] Supabase URL: ${BAKED_SUPABASE_URL} -> ${RUNTIME_SUPABASE_URL}"
  fi
fi

# Supabase URL (dev builds with local Supabase CLI URLs)
# Replace FULL URLs first (http://host:port) to avoid leaving stale scheme prefixes.
# e.g. http://127.0.0.1:54321 -> https://e2e-test.kortix.cloud (not http://https://...)
if [ -n "$RUNTIME_SUPABASE_URL" ]; then
  for dev_url in $DEV_SUPABASE_URLS; do
    for scheme in "https://" "http://"; do
      full_dev_url="${scheme}${dev_url}"
      if grep -rq "$full_dev_url" "$BUNDLE_DIR" 2>/dev/null; then
        printf 's|%s|%s|g\n' "$full_dev_url" "$RUNTIME_SUPABASE_URL" >> "$SED_SCRIPT"
        needs_rewrite=true
        echo "[entrypoint] Supabase URL (dev): ${full_dev_url} -> ${RUNTIME_SUPABASE_URL}"
      fi
    done
    # Fallback: bare host:port (no scheme) — only if full URL wasn't already matched
    if grep -rq "$dev_url" "$BUNDLE_DIR" 2>/dev/null; then
      printf 's|%s|%s|g\n' "$dev_url" "$RUNTIME_SUPABASE_URL" >> "$SED_SCRIPT"
      needs_rewrite=true
      echo "[entrypoint] Supabase URL (dev bare): ${dev_url} -> ${RUNTIME_SUPABASE_URL}"
    fi
  done
fi

# Supabase anon key — check both the official placeholder and common local dev keys
# that may be baked in from .env during local builds.
DEV_ANON_KEYS="$BAKED_ANON_KEY"
# Supabase CLI default publishable key pattern (sb_publishable_*)
# shellcheck disable=SC2013 # Matches contain no whitespace and become a word list below.
for dev_key in $(grep -roh 'sb_publishable_[A-Za-z0-9_-]\{1,50\}' "$BUNDLE_DIR" 2>/dev/null | sort -u); do
  DEV_ANON_KEYS="$DEV_ANON_KEYS $dev_key"
done

if [ -n "$RUNTIME_ANON_KEY" ]; then
  for baked_key in $DEV_ANON_KEYS; do
    if [ "$RUNTIME_ANON_KEY" != "$baked_key" ] && grep -rq "$baked_key" "$BUNDLE_DIR" 2>/dev/null; then
      printf 's|%s|%s|g\n' "$baked_key" "$RUNTIME_ANON_KEY" >> "$SED_SCRIPT"
      needs_rewrite=true
      echo "[entrypoint] Supabase anon key: replacing ($baked_key)"
    fi
  done
fi

# Backend URL (/v1 path)
if [ -n "$RUNTIME_BACKEND_URL" ] && [ "$RUNTIME_BACKEND_URL" != "$BAKED_BACKEND_URL" ]; then
  if grep -rq "$BAKED_BACKEND_URL" "$BUNDLE_DIR" 2>/dev/null; then
    printf 's|%s|%s|g\n' "$BAKED_BACKEND_URL" "${RUNTIME_BACKEND_URL%/}" >> "$SED_SCRIPT"
    needs_rewrite=true
    echo "[entrypoint] Backend: ${BAKED_BACKEND_URL} -> ${RUNTIME_BACKEND_URL}"
  fi
fi

# Backend host (without /v1 — some code references the base URL directly)
if [ -n "$RUNTIME_BACKEND_HOST" ] && [ "$RUNTIME_BACKEND_HOST" != "$BAKED_BACKEND_HOST" ]; then
  if grep -rq "$BAKED_BACKEND_HOST" "$BUNDLE_DIR" 2>/dev/null; then
    printf 's|%s|%s|g\n' "$BAKED_BACKEND_HOST" "$RUNTIME_BACKEND_HOST" >> "$SED_SCRIPT"
    # Don't log separately — covered by backend URL above
  fi
fi

# ── Billing flag rewrite ──────────────────────────────────────────────────────
# Next.js compiles `NEXT_PUBLIC_BILLING_ENABLED === 'true'` into minified
# boolean checks: BILLING_ENABLED:!0 (true) or BILLING_ENABLED:!1 (false).
if [ "$RUNTIME_BILLING" = "false" ] && grep -rq 'BILLING_ENABLED:!0' "$BUNDLE_DIR" 2>/dev/null; then
  echo "[entrypoint] Billing: ON (baked) -> OFF (runtime)"
  find "$BUNDLE_DIR" -name '*.js' -type f -exec grep -l 'BILLING_ENABLED:!0' {} + 2>/dev/null | \
    while read -r f; do sed -i 's|BILLING_ENABLED:!0|BILLING_ENABLED:!1|g' "$f"; done
  needs_rewrite=true
elif [ "$RUNTIME_BILLING" = "true" ] && grep -rq 'BILLING_ENABLED:!1' "$BUNDLE_DIR" 2>/dev/null; then
  echo "[entrypoint] Billing: OFF (baked) -> ON (runtime)"
  find "$BUNDLE_DIR" -name '*.js' -type f -exec grep -l 'BILLING_ENABLED:!1' {} + 2>/dev/null | \
    while read -r f; do sed -i 's|BILLING_ENABLED:!1|BILLING_ENABLED:!0|g' "$f"; done
  needs_rewrite=true
else
  echo "[entrypoint] Billing: $([ "$RUNTIME_BILLING" = "true" ] && echo ON || echo OFF) (no rewrite needed)"
fi

# ── Apply rewrites ────────────────────────────────────────────────────────────
if [ "$needs_rewrite" = "true" ] && [ -s "$SED_SCRIPT" ]; then
  echo "[entrypoint] Rewriting baked values in Next.js bundle..."
  find "$BUNDLE_DIR" -name '*.js' -o -name '*.html' | while read -r file; do
    sed -i -f "$SED_SCRIPT" "$file"
  done
  echo "[entrypoint] Rewrite complete"
elif [ "$needs_rewrite" != "true" ]; then
  echo "[entrypoint] No URL rewrites needed"
fi

rm -f "$SED_SCRIPT"

# Start the server
exec node apps/web/server.js
