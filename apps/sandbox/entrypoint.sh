#!/usr/bin/env bash
# Thin entrypoint: hand control to the compiled daemon. Lives in
# apps/sandbox/ because it's a property of the image, not the daemon
# source package.
set -euo pipefail
exec /usr/local/bin/kortix-agent "$@"
