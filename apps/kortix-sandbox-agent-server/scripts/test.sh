#!/usr/bin/env bash
# The kortixd unit suite. Same hermetic contract as apps/api/scripts/test.env:
# identical on a laptop, a CI runner and a Kortix worker sandbox, so the ambient
# platform state is stripped before bun test starts.
set -euo pipefail
cd "$(dirname "$0")/.."

. ../../scripts/hermetic-test-env.sh

# The box's baked platform artifacts are production state the suite must not
# see: the baked LLM catalog turns "no catalog" fixtures into a 7594-model
# catalog, the baked scaffold turns clone tests into scaffold fast paths, and
# the baked managed skills leak into every skill listing. Point each at its
# existing env seam (or an empty dir) so this box runs as a laptop.
export KORTIX_SCAFFOLD_REPO_PATH=/nonexistent
export KORTIX_BAKED_LLM_CATALOG_FILE=/nonexistent
export KORTIX_SESSION_ENV_FILE=/nonexistent
export KORTIX_MANAGED_SKILLS_DIR="$(mktemp -d /tmp/kortix-hermetic-managed-skills.XXXXXX)"

exec bun test --timeout ${KORTIX_TEST_TIMEOUT_MS:-15000} "$@"
