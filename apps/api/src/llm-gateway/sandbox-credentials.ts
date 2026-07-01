import type { Effect } from 'effect';
import { CATALOG } from '@kortix/llm-catalog';

// Provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, …). When any of these is
// present in opencode's process env, opencode auto-connects a NATIVE provider and
// talks to it DIRECTLY, bypassing the gateway. These must be withheld from the
// opencode process (the daemon enforces this) so the gateway is the only LLM path.
// Codex/OpenCode subscription auth is deliberately NOT here: it's an intentional
// native provider, materialized into opencode's auth.json at boot.
const PROVIDER_CREDENTIAL_ENV: Set<string> = (() => {
  const names = new Set<string>();
  for (const provider of CATALOG.providers) {
    for (const envVar of provider.env ?? []) names.add(envVar);
  }
  return names;
})();

const GATEWAY_MANAGED_ENV: Set<string> = new Set<string>([
  'CODEX_AUTH_JSON',
  'OPENCODE_AUTH_JSON',
  ...PROVIDER_CREDENTIAL_ENV,
]);

/** Provider API-key env names opencode must never see (gateway-only routing). */
export function nativeProviderEnvNames(): string[] {
  return [...PROVIDER_CREDENTIAL_ENV];
}

export function isGatewayManagedEnv(name: string): boolean {
  return GATEWAY_MANAGED_ENV.has(name);
}

export function stripGatewayManagedCredentials(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!GATEWAY_MANAGED_ENV.has(key)) out[key] = value;
  }
  return out;
}
