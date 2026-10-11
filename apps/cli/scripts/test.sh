#!/usr/bin/env bash
# The @kortix/cli unit suite. Same hermetic contract as apps/api/scripts/test.sh:
# identical on a laptop, a CI runner and a Kortix worker sandbox, so the ambient
# platform state is stripped before bun test starts.
set -euo pipefail
cd "$(dirname "$0")/.."

. ../../scripts/hermetic-test-env.sh

exec bun test --timeout ${KORTIX_TEST_TIMEOUT_MS:-15000} --isolate --parallel=4 "$@"
