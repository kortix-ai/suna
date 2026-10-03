/**
 * Scrub the platform-injected sandbox env out of test processes.
 *
 * Inside a Kortix-managed sandbox the session exports a family of KORTIX_*
 * variables that describe THIS session (supervised flag, session and project
 * ids, tokens, API/frontend/LLM URLs, harness and compiled-runtime identity,
 * snapshot pins) plus a `/dev/shm/kortix/agent-env.sh` file that the CLI and
 * the API read as a fallback. Tests otherwise adopt those values as if they
 * were the machine's own: a "not supervised" premise fails, a golden help
 * output grows a session breadcrumb, a compiled runtime identity mismatches
 * (exit 78) before its test can assert anything.
 *
 * The reference environment for this suite is a CI runner, where none of
 * those variables exists — so the invariant is simply "the test process env
 * holds no sandbox KORTIX_* value". Everything the test harness itself sets
 * is in the keep-list. On a developer machine and on CI the scrub is a no-op.
 *
 * Tests that need a value set it themselves. A child spawned with an explicit
 * env never sees this process.env — such spawns set
 * `KORTIX_DISABLE_SANDBOX_ENV_FILE: '1'` themselves (the e2e-cli harness,
 * gateway.test, e2e-connector-faces).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** KORTIX_* variables the test harness (not the sandbox) sets on purpose. */
const HARNESS_SET_KORTIX_KEYS = new Set([
  'KORTIX_TEST_TIMEOUT_MS',
  'KORTIX_MIN_TEST_FILES',
  'KORTIX_API_TEST_WORKERS',
  'KORTIX_PACKAGE_SKIP_SDK_TESTS',
  'KORTIX_TEST_REAL_HOME',
  'KORTIX_NO_UPDATE_CHECK',
  'KORTIX_TEST_PT_ENV_PATH',
]);

export function scrubSandboxInjectedEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('KORTIX_') && !HARNESS_SET_KORTIX_KEYS.has(key)) delete env[key];
  }
  // The sandbox points BASH_ENV at its generated agent-env file; no test shell
  // should source it.
  delete env.BASH_ENV;
  // The daemon's boot-config root defaults to /opt/kortix/config, which only
  // exists inside a sandbox image: left alone, tests that spawn a daemon read
  // the platform's real agent files (and their models) instead of their
  // fixtures. Point it at an absent path; a test that needs a boot link calls
  // serveTestConfigDir, which sets its own.
  env.KORTIX_BOOT_CONFIG_ROOT ??= join(tmpdir(), `kortix-test-boot-config-${process.pid}`);
  // Same for the baked managed-skills overlay: managedSkillsDir() falls back to
  // /opt/kortix/managed-skills, which exists only in the image and would inject
  // the platform's own skills into every rig. A test that exercises the overlay
  // sets its own path.
  env.KORTIX_MANAGED_SKILLS_DIR ??= join(tmpdir(), `kortix-test-absent-managed-skills-${process.pid}`);
  // Children that inherit this env must not read the platform's agent-env
  // file either.
  env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
}

// Imported as a bunfig `[test] preload`: the scrub applies before the first
// test module loads.
scrubSandboxInjectedEnv();
