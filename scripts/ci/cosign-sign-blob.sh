#!/usr/bin/env bash
# Sign a release checksum manifest with keyless cosign, producing the
# `.bundle` an installer can verify against.
#
# Why: `scripts/install.sh` already refuses to run a binary whose SHA-256 is not
# in SHA256SUMS, but it fetches SHA256SUMS over the same channel as the binary.
# An attacker who can replace the binary can replace the manifest too — the
# checksum proves integrity only against corruption, not against the publisher
# (pentest 2026-10-22, "release/code integrity TOFU"). A Sigstore bundle ties
# the manifest to this workflow's OIDC identity, which an attacker would also
# have to forge.
#
# Keyless: no long-lived key to leak or rotate. The signing certificate names
# the workflow that ran, and every signature lands in the public Rekor log.
set -euo pipefail

manifest="${1:-}"
if [ -z "$manifest" ] || [ ! -s "$manifest" ]; then
  echo "usage: $0 <checksum-manifest>  (non-empty file)" >&2
  exit 2
fi
if ! command -v cosign >/dev/null 2>&1; then
  echo "::error::cosign not on PATH (add sigstore/cosign-installer before this step)" >&2
  exit 1
fi

bundle="${manifest}.bundle"
max_attempts="${COSIGN_MAX_ATTEMPTS:-3}"
retry_delay_seconds="${COSIGN_RETRY_DELAY_SECONDS:-10}"
[[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || { echo "COSIGN_MAX_ATTEMPTS must be a positive integer" >&2; exit 2; }
[[ "$retry_delay_seconds" =~ ^[0-9]+$ ]] || { echo "COSIGN_RETRY_DELAY_SECONDS must be a non-negative integer" >&2; exit 2; }

attempt=1
while :; do
  set +e
  output="$(cosign sign-blob --yes --bundle "$bundle" "$manifest" 2>&1)"
  status=$?
  set -e
  [ -z "$output" ] || printf '%s\n' "$output" >&2

  if [ "$status" -eq 0 ]; then
    break
  fi
  # Rekor can persist an entry and lose the response; the retry then reports
  # the entry already exists, which is the operation succeeding twice.
  if grep -Fq 'equivalent entry already exists' <<<"$output" && [ -s "$bundle" ]; then
    echo "cosign: equivalent Rekor entry already exists; accepting."
    break
  fi
  if [ "$attempt" -lt "$max_attempts" ] \
    && grep -Eq 'rekor\.sigstore\.dev|transparency log' <<<"$output" \
    && grep -Eqi 'giving up|timed out|timeout|temporarily unavailable|connection reset|unexpected EOF|[^0-9]50[0234][^0-9]' <<<"$output"; then
    echo "cosign: transient Rekor failure on attempt ${attempt}/${max_attempts}; retrying."
    sleep "$retry_delay_seconds"
    attempt=$((attempt + 1))
    continue
  fi
  exit "$status"
done

[ -s "$bundle" ] || { echo "::error::cosign produced no bundle at $bundle" >&2; exit 1; }
echo "✔ signed $(basename "$manifest") → $(basename "$bundle")"
