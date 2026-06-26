import { CATALOG } from '@kortix/shared/llm-catalog';

// Model-affecting credential env names: every provider API-key var from the
// catalog (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) plus the Codex/OpenCode
// subscription auth blobs. Setting/changing any of these changes which models
// opencode can serve, so a secret write of one of these names triggers a model
// refresh (see projects/routes/r3.ts). (BYOK keys are NO LONGER withheld from
// opencode — it auto-detects each native provider from these env vars.)
const PROVIDER_CREDENTIAL_ENV: Set<string> = (() => {
  const names = new Set<string>();
  for (const provider of CATALOG.providers) {
    for (const envVar of provider.env ?? []) names.add(envVar);
  }
  return names;
})();

const MODEL_AFFECTING_ENV: Set<string> = new Set<string>([
  'CODEX_AUTH_JSON',
  'OPENCODE_AUTH_JSON',
  ...PROVIDER_CREDENTIAL_ENV,
]);

/** True when setting/clearing this env var changes opencode's available models. */
export function isGatewayManagedEnv(name: string): boolean {
  return MODEL_AFFECTING_ENV.has(name);
}
