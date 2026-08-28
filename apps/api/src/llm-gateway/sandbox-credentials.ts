import { runtimeModelCatalog } from './models/runtime-catalog';

// Provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). When any of these is
// present in opencode's process env, opencode auto-connects a NATIVE provider and
// talks to it DIRECTLY, bypassing the gateway. These must be withheld from the
// opencode process (the daemon enforces this) so the gateway is the only LLM path.
// CODEX_AUTH_JSON is gateway-only. OPENCODE_AUTH_JSON remains a legacy managed
// name until its native OpenCode path is removed.
let cachedRevision = -1;
let cachedProviderEnv = new Set<string>();

function providerCredentialEnv(): Set<string> {
  const revision = runtimeModelCatalog.status().revision;
  if (revision === cachedRevision) return cachedProviderEnv;
  const names = new Set<string>();
  for (const provider of runtimeModelCatalog.snapshot().providers) {
    for (const envVar of provider.env ?? []) names.add(envVar);
  }
  cachedProviderEnv = names;
  cachedRevision = revision;
  return cachedProviderEnv;
}

function isManagedEnv(name: string): boolean {
  return name === 'CODEX_AUTH_JSON'
    || name === 'OPENCODE_AUTH_JSON'
    || providerCredentialEnv().has(name);
}

/** Provider API-key env names opencode must never see (gateway-only routing). */
export function nativeProviderEnvNames(): string[] {
  return [...providerCredentialEnv()];
}

/**
 * Names a model provider claims that users overwhelmingly set for something
 * else.
 *
 * models.dev maps `github-copilot` to `GITHUB_TOKEN`, so every project secret
 * called `GITHUB_TOKEN` looked like a Copilot BYOK credential. At create time
 * that guess is wrong far more often than right: people store a GitHub PAT to
 * clone, push, and open pull requests, not to talk to Copilot. Guessing wrong
 * stamped the row `broker`/`llm_gateway`, which withheld it from the sandbox —
 * so the agent could not use the token the user had just added, and the UI gave
 * no hint why (prod 2026-08-27).
 *
 * This ONLY relaxes the create-time default. A user who really is connecting
 * Copilot still says so explicitly with `strategy`/`consumer`, and nothing here
 * changes how an already-stamped row is delivered.
 */
const DUAL_PURPOSE_CREDENTIAL_ENV = new Set(['GITHUB_TOKEN']);

export function isDualPurposeCredentialEnv(name: string): boolean {
  return DUAL_PURPOSE_CREDENTIAL_ENV.has(name);
}

export function isGatewayManagedEnv(name: string): boolean {
  return isManagedEnv(name);
}

export function stripGatewayManagedCredentials(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!isManagedEnv(key)) out[key] = value;
  }
  return out;
}
