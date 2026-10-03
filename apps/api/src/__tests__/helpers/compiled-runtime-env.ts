/**
 * A Kortix session box exports the platform's compiled-runtime identity:
 * KORTIX_PROJECT_ID, KORTIX_BASE_REF, KORTIX_BASE_SHA and the baked agent
 * config. A compiled runtime fails closed (exit 78) when an ambient value
 * differs from its baked manifest, so a test that runs one under the session's
 * own env measures the box, not the bake. Strip the identity namespace; tests
 * layer their explicit overrides on top.
 */
const COMPILED_IDENTITY_VARS = [
  'KORTIX_COMPILED_RUNTIME_FORMAT',
  'KORTIX_COMPILED_RUNTIME_SOURCE_SHA',
  'KORTIX_PROJECT_ID',
  'KORTIX_DEFAULT_BRANCH',
  'KORTIX_BASE_REF',
  'KORTIX_BASE_SHA',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
] as const;

export function compiledRuntimeChildEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !(COMPILED_IDENTITY_VARS as readonly string[]).includes(key)) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}
