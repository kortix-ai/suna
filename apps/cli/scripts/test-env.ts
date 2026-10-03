/**
 * bun test preload (apps/cli/bunfig.toml `[test] preload`).
 *
 * The CLI test suite must be hermetic: identical on a laptop and inside a
 * Kortix worker sandbox. A worker exports the live session's platform env
 * (apps/sandbox/entrypoint.sh + /dev/shm/kortix/agent-env.sh) into every shell
 * its tests inherit: the host line renders "host env … · session <id>" and the
 * supervised gates trip, so golden-output and install tests fail there and
 * only there. Drop the injected names and close the sandbox-env file before
 * any test module loads; tests that exercise one of these states set the var
 * themselves.
 */
const INJECTED_KEYS = [
  // The live session's identity and host.
  'KORTIX_SESSION_ID',
  'KORTIX_SUPERVISED',
  'KORTIX_API_URL',
  'KORTIX_TOKEN',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  // The compiled-runtime identity (compiled runtimes refuse a foreign one).
  'KORTIX_COMPILED_RUNTIME_FORMAT',
  'KORTIX_COMPILED_RUNTIME_SOURCE_SHA',
  'KORTIX_DEFAULT_BRANCH',
  'KORTIX_BASE_REF',
  'KORTIX_BASE_SHA',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
];

for (const key of INJECTED_KEYS) delete process.env[key];
process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
