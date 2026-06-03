#!/usr/bin/env bash
# E2E check for the three local-dev secret environments (dotenvx profiles).
# Proves each profile DECRYPTS cleanly and points at the right stack — i.e. the
# local / dev / prod separation is intact. Safe to run anytime: it only reads
# (decrypts) the env files, it does NOT boot the API or touch any database.
#
#   pnpm test:envs
#
# Needs the dotenvx private keys (apps/api/.env.keys, or `dotenvx-armor login`).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DX="$ROOT/node_modules/.bin/dotenvx"; [ -x "$DX" ] || DX="dotenvx"
fail=0

get() { "$DX" get "$1" -f "$ROOT/$2" 2>/dev/null; }

row() {
  local label="$1" file="$2"
  if [ ! -f "$ROOT/$file" ]; then
    printf "  ✗ %-5s missing %s\n" "$label" "$file"; fail=1; return
  fi
  local db stripe env front; db="$(get DATABASE_URL "$file")"
  stripe="$(get STRIPE_SECRET_KEY "$file")"; env="$(get INTERNAL_KORTIX_ENV "$file")"
  front="$(get FRONTEND_URL "$file")"
  if [ -z "$db" ] || [[ "$db" == encrypted:* ]]; then
    printf "  ✗ %-5s did NOT decrypt (run dotenvx-armor login / pull)\n" "$label"; fail=1; return
  fi
  local host="${db#*@}"; host="${host%%[:/]*}"
  local mode="?"; [[ "$stripe" == sk_live_* ]] && mode="LIVE"; [[ "$stripe" == sk_test_* ]] && mode="test"
  printf "  ✓ %-5s env=%-5s stripe=%-4s db=%-45s front=%s\n" "$label" "${env:-—}" "$mode" "$host" "${front:-—}"
}

echo "dotenvx secret environments (decrypt + separation check):"
echo
row "local" "apps/api/.env"
row "dev"   "apps/api/.env.dev"
row "prod"  "apps/api/.env.prod"
echo
if [ "$fail" = 0 ]; then
  echo "✓ all 3 environments decrypt cleanly and are distinctly configured"
else
  echo "✗ one or more environments failed — see above"
fi
exit "$fail"
