#!/usr/bin/env bash
# The CLI unit suite's entry point. It must be hermetic (see
# ../../api/scripts/test.env): identical on a laptop and on a CI runner, with
# no decryption key and no reachable service. A CI runner carries no KORTIX_*
# runtime context; a platform-managed sandbox injects it into every process
# (session id, supervised flag, API URL and token, agent config, project
# snapshot). That context changes what the CLI under test prints and decides —
# a session id adds a `· session <id>` breadcrumb to host lines,
# KORTIX_API_URL+KORTIX_TOKEN make an unauthenticated CLI read as
# authenticated, KORTIX_SUPERVISED redirects self-update paths — so inheriting
# it here breaks suites that are green on CI. Tests that exercise that behavior
# set what they need themselves. Clear every inherited KORTIX_* except the
# test harness's own knobs (timeout, package-quality's attachment switch).
# sandboxEnvValue() also falls back to the platform's /dev/shm/kortix/
# agent-env.sh (real session token and project secrets), so forbid reading it
# here the way the CLI's own tests do. The platform also exports that file as
# BASH_ENV, and every non-interactive bash — including this script — sources
# it at startup, re-injecting every KORTIX_* value the loop below just
# removed (measured: the compiled runtime's identity check then rejects the
# foreign KORTIX_PROJECT_ID). Drop BASH_ENV so this script and everything it
# spawns start from the CI condition.
unset BASH_ENV
while IFS='=' read -r key _; do
  case "$key" in
    KORTIX_TEST_TIMEOUT_MS|KORTIX_ATTACHMENT_OFFLOAD) ;;
    KORTIX_*) unset "$key" || true ;;
  esac
done < <(env)
export KORTIX_DISABLE_SANDBOX_ENV_FILE=1

exec bun test --timeout "${KORTIX_TEST_TIMEOUT_MS:-15000}" --isolate --parallel=4 "$@"
