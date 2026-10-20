import { z } from '@hono/zod-openapi';
import type { UpstreamDescriptor } from '@kortix/llm-gateway';
import { config } from '../config';
import { runtimeModelCatalog } from './models/runtime-catalog';

/**
 * A project's own OpenAI-compatible endpoint (Models → Custom): a self-hosted
 * or unlisted model the models.dev catalog does not carry. The definition is
 * stored in `projects.metadata.custom_llm_providers`, next to `model_access`,
 * and its optional key is the project secret `CUSTOM_<ID>_API_KEY`
 * (consumer `llm_gateway`). The gateway serves its models as `<id>/<model>`
 * like any BYOK provider: no Kortix credits, budgets and logs apply.
 */
export interface CustomLlmProviderDefinition {
  id: string;
  name: string;
  base_url: string;
  models: { id: string; name: string }[];
}

export const CUSTOM_PROVIDERS_METADATA_KEY = 'custom_llm_providers';
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Synthetic providers the gateway owns. Catalog provider ids are checked live.
const RESERVED_IDS = new Set(['kortix', 'codex', 'auto']);

export const CustomLlmProviderInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  base_url: z.string().trim().url().max(2048).refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  }, 'Base URL must be http(s) and carry no credentials'),
  models: z.array(z.object({
    id: z.string().trim().min(1).max(200).regex(/^\S+$/, 'Model ids have no whitespace'),
    name: z.string().trim().min(1).max(100),
  })).min(1).max(50),
});
export type CustomLlmProviderInput = z.infer<typeof CustomLlmProviderInputSchema>;

export function customProviderSecretName(id: string): string {
  return `CUSTOM_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

/** The provider id a `CUSTOM_<ID>_API_KEY` secret names, or null. Lossy for `-` vs `_`. */
export function customProviderIdFromSecret(name: string): string | null {
  const match = /^CUSTOM_([A-Z0-9_]+)_API_KEY$/.exec(name);
  return match ? match[1]!.toLowerCase() : null;
}

/** Why `id` cannot name a custom provider, or null. */
export function customProviderIdError(id: string): 'invalid_body' | 'reserved_provider_id' | null {
  if (!PROVIDER_ID.test(id)) return 'invalid_body';
  if (RESERVED_IDS.has(id) || runtimeModelCatalog.snapshot().providers.some((p) => p.id === id)) {
    return 'reserved_provider_id';
  }
  return null;
}

export function readCustomProviders(metadata: unknown): CustomLlmProviderDefinition[] {
  const value = (metadata as Record<string, unknown> | null)?.[CUSTOM_PROVIDERS_METADATA_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CustomLlmProviderDefinition =>
    !!entry && typeof entry.id === 'string' && typeof entry.base_url === 'string' && Array.isArray(entry.models));
}

/** The list with `id` replaced (or appended), sorted by id. */
export function upsertCustomProvider(
  list: CustomLlmProviderDefinition[],
  id: string,
  input: CustomLlmProviderInput,
): CustomLlmProviderDefinition[] {
  const bare = (modelId: string) => (modelId.startsWith(`${id}/`) ? modelId.slice(id.length + 1) : modelId);
  const models = [...new Map(input.models.map((m) => [bare(m.id), m.name])).entries()]
    .map(([modelId, name]) => ({ id: modelId, name }));
  const next = { id, name: input.name, base_url: input.base_url.replace(/\/+$/, ''), models };
  return [...list.filter((p) => p.id !== id), next].sort((a, b) => a.id.localeCompare(b.id));
}

/** The project's custom models in the served-catalog shape, keyed `<provider>/<model>`. */
export function customProviderCatalog(providers: CustomLlmProviderDefinition[]) {
  const out: Record<string, {
    name: string; provider: string; provider_name: string; tool_call: boolean; temperature: boolean;
    attachment: boolean; limit: { context: number; output: number };
  }> = {};
  for (const provider of providers) {
    for (const model of provider.models) {
      out[`${provider.id}/${model.id}`] = {
        name: model.name,
        provider: provider.id,
        provider_name: provider.name,
        tool_call: true,
        temperature: true,
        attachment: false,
        // ponytail: one default window; add a per-model limit to the form when a small-context endpoint needs it.
        limit: { context: 128_000, output: 16_000 },
      };
    }
  }
  return out;
}

/**
 * The upstream for a custom model. OpenAI-compatible `/chat/completions`,
 * billed to the endpoint owner. The gateway calls the base URL from inside
 * our network, so `egress` makes it refuse private addresses unless the
 * operator allowlisted the host.
 */
export function customProviderDescriptor(
  provider: CustomLlmProviderDefinition,
  modelId: string,
  apiKey: { value: string; secretId: string } | null,
): UpstreamDescriptor {
  return {
    provider: provider.id,
    kind: 'openai-compat',
    baseUrl: provider.base_url,
    apiKey: apiKey?.value ?? '',
    ...(apiKey ? { credentialRef: apiKey.secretId } : { omitAuthorization: true }),
    billingMode: 'none',
    markup: 0,
    resolvedModel: modelId,
    egress: { allowPrivateHosts: config.KORTIX_LLM_CUSTOM_PROVIDER_ALLOW_HOSTS },
  };
}
