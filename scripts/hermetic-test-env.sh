# Hermetic baseline for the unit suites (apps/api/scripts/test.sh,
# apps/cli/scripts/test.sh, apps/kortix-sandbox-agent-server/scripts/test.sh).
# Source it; it edits the current environment.
#
# The unit suites must be hermetic: identical on a laptop, a CI runner and a
# Kortix worker sandbox (apps/api/scripts/test.env states the contract). A
# worker sandbox is itself a managed Kortix box, so the platform state leaks
# in through three paths and breaks that contract:
#   1. Ambient KORTIX_* exports (KORTIX_PROJECT_ID, KORTIX_TOKEN,
#      KORTIX_SESSION_ID, KORTIX_SUPERVISED, ...). bun's --env-file does not
#      override ambient values, so they win over the fake values in
#      scripts/test.env, and children spawned with `env: {...process.env}`
#      inherit them — the compiled-runtime identity checks exit 78 against the
#      box's real project id, the CLI golden output gains a `· session` suffix
#      and the "host env" label, and the supervised download/update guards
#      refuse the paths under test.
#   2. The platform env file (/dev/shm/kortix/agent-env.sh, BASH_ENV) that
#      packages/shared/src/host-config/sandbox-env.ts reads inside
#      sandboxEnvValue() when the var is not in the environment.
#   3. Children spawned with an explicit minimal env object: they inherit
#      nothing, so path 2 applies to them unless each child carries the
#      documented opt-out itself.
#   4. The developer's own CLI login: the multi-host config store defaults to
#      ~/.config/kortix/config.json, and a `kortix login` there (including the
#      KRTX-1705 in-sandbox selection marker, which would flip the suite's
#      injected KORTIX_TOKENs to the stored credential) must not reach the
#      suite. Point KORTIX_CONFIG_FILE at a fresh path so every loadConfig()
#      sees an empty store; the legacy single-host import only fires on the
#      default path, so this cuts ~/.config/kortix/auth.json off too. Children
#      spawned with an explicit env object need `KORTIX_CONFIG_FILE:
#      process.env.KORTIX_CONFIG_FILE` of their own — they inherit nothing.
# Unset every ambient KORTIX_* var the suites do not own and disable the
# platform env file, so a worker box behaves exactly like a laptop that has
# neither. The knobs the test infrastructure itself passes down stay.
while IFS= read -r name; do
  case "$name" in
    KORTIX_TEST_TIMEOUT_MS|KORTIX_ATTACHMENT_OFFLOAD|KORTIX_PACKAGE_SKIP_SDK_TESTS|KORTIX_API_TEST_WORKERS|KORTIX_MIN_TEST_FILES) ;;
    KORTIX_*) unset "$name" ;;
  esac
done < <(compgen -e)
# The documented opt-out (packages/shared/src/host-config/sandbox-env.ts):
# in-process sandboxEnvValue() reads must never see the platform file here.
# Children spawned with an explicit env object still need
# KORTIX_DISABLE_SANDBOX_ENV_FILE: '1' of their own — they inherit nothing.
export KORTIX_DISABLE_SANDBOX_ENV_FILE=1
# Path 4: a suite-owned, empty config store (see the leak list above).
KORTIX_TEST_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kortix-hermetic-config.XXXXXX")"
export KORTIX_CONFIG_FILE="$KORTIX_TEST_CONFIG_DIR/config.json"
