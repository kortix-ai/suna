#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_build.sh"
build_target bun-linux-x64 kortix-linux-x64
