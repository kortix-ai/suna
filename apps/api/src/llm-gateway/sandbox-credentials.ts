import { runtimeModelCatalog } from './models/runtime-catalog';

// Provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). When any of these is
// present in opencode's process env, opencode auto-connects a NATIVE provider and
// talks to it DIRECTLY, bypassing the gateway. These must be withheld from the
// opencode process (the daemon enforces this) so the gateway is the only LLM path.
// Codex/OpenCode subscription auth is deliberately NOT here: it's an intentional
// native provider, materialized into opencode's auth.json at boot.
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
