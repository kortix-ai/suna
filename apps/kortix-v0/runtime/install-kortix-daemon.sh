#!/usr/bin/env bash
set -euo pipefail

target="${1:-/usr/local/bin/kortix-daemon}"
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 0755 "$source_dir/kortix-daemon" "$target"
echo "installed $target"
