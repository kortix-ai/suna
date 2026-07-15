import type { HarnessAuthKind, HarnessId } from '@kortix/sdk';

export type ProjectProviderConnectionMode =
  | 'managed'
  | 'token'
  | 'api-key'
  | 'oauth'
  | 'custom'
  | 'native';

export interface ProjectProviderConnectionDefinition {
  id: HarnessAuthKind;
  label: string;
  description: string;
  providerId: string;
  mode: ProjectProviderConnectionMode;
  secretNames: string[];
  compatibleHarnesses: HarnessId[];
  placeholder?: string;
  helpUrl?: string;
}

/**
 * Mobile presentation metadata for the server-authoritative harness connection
 * kinds. Readiness and active routing always come from /harness-connections;
 * this table only owns labels and the project-secret form contract.
 *
 * `compatibleHarnesses` mirrors the server's source of truth (2026-07-15
 * simplification, apps/api/src/projects/lib/composer-capabilities.ts
 * CONNECTIONS table): Claude Code and Codex are harness-only (their own
 * subscription, their own provider API key, or native config) — never the
 * Kortix managed gateway, never a custom endpoint. OpenCode and Pi keep the
 * full gateway story.
 */
export const PROJECT_PROVIDER_CONNECTIONS: ProjectProviderConnectionDefinition[] = [
  {
    id: 'managed_gateway',
    label: 'Kortix',
    description: 'Included — no setup needed. Routed by Kortix for OpenCode and Pi.',
    providerId: 'kortix',
    mode: 'managed',
    secretNames: [],
    compatibleHarnesses: ['opencode', 'pi'],
  },
  {
    id: 'claude_subscription',
    label: 'Claude subscription',
    description: 'Claude Pro, Max, Team, or Enterprise through Claude Code.',
    providerId: 'anthropic',
    mode: 'token',
    secretNames: ['CLAUDE_CODE_OAUTH_TOKEN'],
    compatibleHarnesses: ['claude'],
    placeholder: 'Paste the token from claude setup-token',
    helpUrl: 'https://docs.anthropic.com/en/docs/claude-code/iam',
  },
  {
    id: 'anthropic_api_key',
    label: 'Anthropic API',
    description: 'Use an Anthropic API key with Claude, OpenCode, or Pi.',
    providerId: 'anthropic',
    mode: 'api-key',
    secretNames: ['ANTHROPIC_API_KEY'],
    compatibleHarnesses: ['claude', 'opencode', 'pi'],
    placeholder: 'sk-ant-...',
    helpUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'codex_subscription',
    label: 'ChatGPT / Codex subscription',
    description: 'ChatGPT Plus, Pro, Business, Edu, or Enterprise through Codex.',
    providerId: 'openai',
    mode: 'oauth',
    secretNames: ['CODEX_AUTH_JSON'],
    compatibleHarnesses: ['codex'],
    helpUrl: 'https://developers.openai.com/codex/auth',
  },
  {
    id: 'openai_api_key',
    label: 'OpenAI API',
    description: 'Use an OpenAI API key with Codex, OpenCode, or Pi.',
    providerId: 'openai',
    mode: 'api-key',
    secretNames: ['OPENAI_API_KEY'],
    compatibleHarnesses: ['codex', 'opencode', 'pi'],
    placeholder: 'sk-...',
    helpUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openai_compatible',
    label: 'OpenAI-compatible REST',
    description: 'Bring a custom OpenAI-compatible base URL, model, and key.',
    providerId: 'custom-rest',
    mode: 'custom',
    secretNames: [
      'CUSTOM_LLM_PROTOCOL',
      'CUSTOM_LLM_BASE_URL',
      'CUSTOM_LLM_API_KEY',
      'CUSTOM_LLM_MODEL_ID',
      'CUSTOM_LLM_NAME',
    ],
    compatibleHarnesses: ['opencode', 'pi'],
  },
  // Parked (2026-07-15): no harness is compatible with a custom Anthropic-
  // protocol endpoint now that Claude Code custom routing — its only
  // consumer — is cut. Definition kept (never offered by any harness) so an
  // existing legacy connection can still be surfaced/managed.
  {
    id: 'anthropic_compatible',
    label: 'Anthropic-compatible REST',
    description: 'Bring a custom Anthropic-compatible base URL, model, and key.',
    providerId: 'custom-rest',
    mode: 'custom',
    secretNames: [
      'CUSTOM_LLM_PROTOCOL',
      'CUSTOM_LLM_BASE_URL',
      'CUSTOM_LLM_API_KEY',
      'CUSTOM_LLM_MODEL_ID',
      'CUSTOM_LLM_NAME',
    ],
    compatibleHarnesses: [],
  },
  {
    id: 'native_config',
    label: 'Project config',
    description: "Uses the repo's committed setup.",
    providerId: 'native',
    mode: 'native',
    secretNames: [],
    compatibleHarnesses: ['claude', 'codex', 'opencode', 'pi'],
  },
];

export const PROJECT_PROVIDER_CONNECTION_BY_ID = new Map(
  PROJECT_PROVIDER_CONNECTIONS.map((entry) => [entry.id, entry]),
);

export function compatibleHarnessesWithoutActiveRoute(
  definition: ProjectProviderConnectionDefinition,
  connections: Array<{ id: HarnessAuthKind; active_for: HarnessId[] }>,
): HarnessId[] {
  const alreadyBound = new Set(connections.flatMap((connection) => connection.active_for));
  return definition.compatibleHarnesses.filter((harness) => !alreadyBound.has(harness));
}

export function secretWritesForConnection(
  connectionId: HarnessAuthKind,
  value: string,
): Array<{ name: string; value: string }> {
  const definition = PROJECT_PROVIDER_CONNECTION_BY_ID.get(connectionId);
  if (!definition) throw new Error(`Unknown harness connection: ${connectionId}`);
  if (definition.mode === 'oauth') {
    throw new Error(`${definition.label} is connected through the project OAuth flow.`);
  }
  if (definition.mode !== 'api-key' && definition.mode !== 'token') {
    throw new Error(`${definition.label} does not accept a single credential value.`);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Credential value is required.');
  return definition.secretNames.map((name) => ({ name, value: trimmed }));
}

export function customProviderSecretWrites(input: {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  modelId: string;
  name: string;
}): Array<{ name: string; value: string }> {
  return [
    { name: 'CUSTOM_LLM_PROTOCOL', value: input.protocol },
    { name: 'CUSTOM_LLM_BASE_URL', value: input.baseUrl.trim() },
    { name: 'CUSTOM_LLM_API_KEY', value: input.apiKey.trim() },
    { name: 'CUSTOM_LLM_MODEL_ID', value: input.modelId.trim() },
    { name: 'CUSTOM_LLM_NAME', value: input.name.trim() },
  ];
}
