#!/usr/bin/env bash
# The kortixd unit suite. Same hermetic contract as apps/api/scripts/test.env:
# identical on a laptop, a CI runner and a Kortix worker sandbox, so the ambient
# platform state is stripped before bun test starts. The box's own baked
# artifacts and /etc/pt-env are per-test-pinned by the tests that need them
# absent; this entry only strips the ambient environment.
set -euo pipefail
cd "$(dirname "$0")/.."

. ../../scripts/hermetic-test-env.sh

# Four isolated workers, as apps/cli: the serial run took 254-366 s, most of
# it in tests that wait on real processes and timers.
exec bun test --timeout ${KORTIX_TEST_TIMEOUT_MS:-15000} --isolate --parallel=4 "$@"
