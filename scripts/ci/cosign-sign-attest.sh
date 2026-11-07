#!/usr/bin/env bash
set -euo pipefail

ref="${1:-}"
predicate="${2:-}"
# shellcheck source=scripts/ci/lib/cosign-retry.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/cosign-retry.sh"

# The predicate is optional: `deploy-prod.yml` signs the release images it
# retagged (no SBOM is generated there), while `deploy-dev.yml` signs and
# attests. Same retry handling either way.
if [ -z "$ref" ]; then
  echo "usage: $0 <image-ref> [spdx-predicate]" >&2
  exit 2
fi
cosign_retry_env

run_with_rekor_retry "image signature" cosign sign --yes "$ref"
if [ -n "$predicate" ]; then
  run_with_rekor_retry "SBOM attestation" \
    cosign attest --yes --type spdxjson --predicate "$predicate" "$ref"
fi
