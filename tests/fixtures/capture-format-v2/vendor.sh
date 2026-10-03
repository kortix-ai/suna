#!/usr/bin/env bash
# Vendor the Kortix Capture format (schema 2) contract from kortix-ai/capture at
# one pinned commit: the JSON Schemas and the synthetic fixture bucket + issuer
# responses. Re-run with a new SHA when the engine changes the contract, then
# update SOURCE.json and run the CAP flows and integration-capture.
#   tests/fixtures/capture-format-v2/vendor.sh <sha>
set -euo pipefail
sha="${1:?usage: vendor.sh <kortix-ai/capture commit sha>}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone -q --filter=blob:none --no-checkout https://github.com/kortix-ai/capture.git "$work/capture"
git -C "$work/capture" sparse-checkout set --no-cone apps/recorder/schemas apps/recorder/fixtures/capture-format-v2
git -C "$work/capture" checkout -q "$sha"
rm -rf "$here/schemas" "$here/bucket" "$here/issuer"
cp -R "$work/capture/apps/recorder/schemas" "$here/schemas"
cp -R "$work/capture/apps/recorder/fixtures/capture-format-v2/bucket" "$here/bucket"
cp -R "$work/capture/apps/recorder/fixtures/capture-format-v2/issuer" "$here/issuer"
full="$(git -C "$work/capture" rev-parse HEAD)"
printf '{\n  "repository": "kortix-ai/capture",\n  "commit": "%s",\n  "paths": ["apps/recorder/schemas", "apps/recorder/fixtures/capture-format-v2"]\n}\n' "$full" > "$here/SOURCE.json"
echo "vendored kortix-ai/capture@$full"
