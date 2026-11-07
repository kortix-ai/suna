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

# shellcheck source=scripts/ci/lib/cosign-retry.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/cosign-retry.sh"
cosign_retry_env

bundle="${manifest}.bundle"
run_with_rekor_retry "cosign" cosign sign-blob --yes --bundle "$bundle" "$manifest"

[ -s "$bundle" ] || { echo "::error::cosign produced no bundle at $bundle" >&2; exit 1; }
echo "✔ signed $(basename "$manifest") → $(basename "$bundle")"
