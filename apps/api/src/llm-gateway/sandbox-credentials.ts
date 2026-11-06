import { primaryAuthEnvVars } from '@kortix/llm-catalog';
import { runtimeModelCatalog } from './models/runtime-catalog';

// Provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). The gateway is the
// only LLM path, so these are withheld from the runtime process (the daemon
// enforces this). CODEX_AUTH_JSON is gateway-only.
let cachedRevision = -1;
let cachedProviderEnv = new Set<string>();

function providerCredentialEnv(): Set<string> {
  const revision = runtimeModelCatalog.status().revision;
  if (revision === cachedRevision) return cachedProviderEnv;
  const names = new Set<string>();
  for (const provider of runtimeModelCatalog.snapshot().providers) {
    for (const envVar of [...(provider.env ?? []), ...primaryAuthEnvVars(provider)]) names.add(envVar);
  }
  cachedProviderEnv = names;
  cachedRevision = revision;
  return cachedProviderEnv;
}

function isManagedEnv(name: string): boolean {
  return name === 'CODEX_AUTH_JSON' || providerCredentialEnv().has(name);
}

export function isGatewayManagedEnv(name: string): boolean {
  return isManagedEnv(name);
}
