#!/usr/bin/env bash
set -euo pipefail

# Pin the installer separately from the binary: newer installers use get.trivy.dev.
INSTALLER="$(mktemp)"
trap 'rm -f "$INSTALLER"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  https://raw.githubusercontent.com/aquasecurity/trivy/0c40a8d4b9b943f1b679a20f8ba3cb61c94831de/contrib/install.sh \
  --output "$INSTALLER"
echo "2304dcc0c1883e802d376eae1b514c923b7427a7d88091dfcaf83967e6f55a7c  $INSTALLER" | sha256sum --check
# The upstream installer verifies the release archive against its SHA-256 manifest.
bash "$INSTALLER" -b "${1:?installation directory required}" v0.70.0
