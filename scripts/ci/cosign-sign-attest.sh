#!/usr/bin/env bash
set -euo pipefail

ref="${1:-}"
predicate="${2:-}"
max_attempts="${COSIGN_MAX_ATTEMPTS:-3}"
retry_delay_seconds="${COSIGN_RETRY_DELAY_SECONDS:-10}"

if [ -z "$ref" ] || [ -z "$predicate" ]; then
  echo "usage: $0 <image-ref> <spdx-predicate>" >&2
  exit 2
fi
if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "COSIGN_MAX_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if ! [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "COSIGN_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
  exit 2
fi

run_with_rekor_retry() {
  local label="$1"
  shift
  local attempt output status

  for attempt in $(seq 1 "$max_attempts"); do
    set +e
    output="$("$@" 2>&1)"
    status=$?
    set -e
    [ -z "$output" ] || printf '%s\n' "$output" >&2

    if [ "$status" -eq 0 ]; then
      return 0
    fi

    # Rekor can persist an entry and lose the response. A retry then returns
    # this exact conflict. The matching entry is the completed operation.
    if grep -Fq 'createLogEntryConflict' <<<"$output" \
      && grep -Fq 'equivalent entry already exists in the transparency log' <<<"$output"; then
      echo "${label}: equivalent Rekor entry already exists; accepting idempotent success."
      return 0
    fi

    if [ "$attempt" -lt "$max_attempts" ] \
      && grep -Eq 'rekor\.sigstore\.dev|transparency log' <<<"$output" \
      && grep -Eqi 'giving up|timed out|timeout|temporarily unavailable|connection reset|unexpected EOF|[^0-9]50[0234][^0-9]' <<<"$output"; then
      echo "${label}: transient Rekor failure on attempt ${attempt}/${max_attempts}; retrying."
      sleep "$retry_delay_seconds"
      continue
    fi

    return "$status"
  done
}

run_with_rekor_retry "image signature" cosign sign --yes "$ref"
run_with_rekor_retry "SBOM attestation" \
  cosign attest --yes --type spdxjson --predicate "$predicate" "$ref"
