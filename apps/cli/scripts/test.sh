#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# The CLI suite spawns the real CLI and reads the box's runtime identity; run
# it against a developer box (scripts/test-box-env.sh), with the bunfig-level
# localhost shim covering name resolution.
. ../../scripts/test-box-env.sh

exec bun test --timeout ${KORTIX_TEST_TIMEOUT_MS:-15000} --isolate --parallel=4 "$@"
