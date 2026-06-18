import { CATALOG } from '@kortix/shared/llm-catalog';

const GATEWAY_MANAGED_ENV: Set<string> = (() => {
  const names = new Set<string>(['CODEX_AUTH_JSON', 'OPENCODE_AUTH_JSON']);
  for (const provider of CATALOG.providers) {
    for (const envVar of provider.env ?? []) names.add(envVar);
  }
  return names;
})();

export function stripGatewayManagedCredentials(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!GATEWAY_MANAGED_ENV.has(key)) out[key] = value;
  }
  return out;
}
