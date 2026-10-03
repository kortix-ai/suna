/**
 * Child env for tests that spawn a compiled runtime (compiled-runtime,
 * compiled-pi-runtime). A compiled runtime refuses to run under a foreign
 * identity (exit 78, "Compiled runtime identity mismatch"), and a Kortix
 * worker sandbox exports the REAL session's identity — KORTIX_PROJECT_ID,
 * KORTIX_BASE_SHA, KORTIX_BASE_REF, KORTIX_DEFAULT_BRANCH and the compiled
 * agent config — into the agent shell every test inherits. A child that
 * spreads the ambient env then fails there and only there.
 *
 * `outsideEnv(source)` is `source` without those names: exactly what a laptop
 * or a CI runner (no such exports) would hand the child. The sandbox-env FILE
 * (`/dev/shm/kortix/agent-env.sh`) is closed separately, by
 * KORTIX_DISABLE_SANDBOX_ENV_FILE=1 in scripts/test.env.
 */
const COMPILED_IDENTITY_KEYS = [
  'KORTIX_COMPILED_RUNTIME_FORMAT',
  'KORTIX_COMPILED_RUNTIME_SOURCE_SHA',
  'KORTIX_PROJECT_ID',
  'KORTIX_DEFAULT_BRANCH',
  'KORTIX_BASE_REF',
  'KORTIX_BASE_SHA',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
] as const;

export function outsideEnv(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };
  for (const name of COMPILED_IDENTITY_KEYS) delete env[name];
  return env;
}
