#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_build.sh"
build_target bun-darwin-arm64 kortix-darwin-arm64
