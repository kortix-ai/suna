/**
 * The environment a hosted Kortix sandbox injects into every process: the
 * agent-env.sh contract (token, urls, project/session ids) plus the platform's
 * own session wiring. CI and a developer laptop never carry them, so a test
 * process that inherits them sees a different world than CI: a spawned CLI
 * adopts the host session (`host env … · session <id>`), a compiled runtime
 * identity mismatches, the harness adapter flips, refresh routes see a repo
 * they never configured. Test preloads call `scrubHostSandboxEnv()` once per
 * test process; a test that needs one of these values sets it explicitly.
 */
const HOST_SANDBOX_ENV_KEYS = [
  // The agent-env.sh contract (packages/shared host-config/sandbox-env.ts).
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  // Platform session wiring.
  'KORTIX_SUPERVISED',
  'KORTIX_HARNESS',
  'KORTIX_REPO_URL',
  'KORTIX_MODEL',
  'KORTIX_OPENCODE_MODEL',
  'KORTIX_LLM_BASE_URL',
  'KORTIX_LLM_PROXY_URL',
  'KORTIX_COMPILED_AGENT_CONFIG',
  'KORTIX_COMPILED_AGENT_CONFIG_ETAG',
  'KORTIX_SECRET_CAPABILITIES',
  'KORTIX_PROJECT_SECRETS_REVISION',
  'KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR',
  'KORTIX_PROJECT_SNAPSHOT_MODE',
  'KORTIX_PROJECT_SNAPSHOT_PIN',
  'KORTIX_BOOTSTRAP_RUNTIME_SESSION',
  'KORTIX_BOOTSTRAP_OPENCODE_SESSION',
  'KORTIX_CONNECTORS_MCP_ENABLED',
  'KORTIX_AGENT_NAME',
  'KORTIX_WORKSPACE',
  'KORTIX_BRANCH_NAME',
  'KORTIX_BASE_SHA',
  'KORTIX_DEFAULT_BRANCH',
  'KORTIX_BASE_REF',
  'KORTIX_SESSION_FRESH',
  'KORTIX_SESSION_CONTEXT',
  'KORTIX_CONTAINER_RUNTIME',
  'KORTIX_FEATURES',
  'KORTIX_SERVICE_PORT',
  'KORTIX_AGENT_STATE_DIR',
  'KORTIX_PROJECT_AUTO_CLONE',
  'KORTIX_REPOSITORY_ACCESS',
  'KORTIX_CLONE_FILTER',
];

export function scrubHostSandboxEnv(): void {
  for (const key of HOST_SANDBOX_ENV_KEYS) delete process.env[key];
}
