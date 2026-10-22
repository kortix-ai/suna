import { z } from '@hono/zod-openapi';
import type { UpstreamDescriptor } from '@kortix/llm-gateway';
import { config } from '../config';
import { resolveProjectSecretsForConsumer } from '../projects/secrets';
import { safeEgressFetch } from '../shared/ssrf-guard';
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
  /** `context`/`output`: the model's token limits, from the input or the endpoint's `GET /models`. */
  models: { id: string; name: string; context?: number; output?: number }[];
}

type ModelLimits = { context?: number; output?: number };

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
    /** Context window in tokens. Absent: read from the endpoint's `GET /models`. */
    context: z.number().int().positive().max(100_000_000).optional(),
    /** Max output tokens. Absent: read from the endpoint, else the context window. */
    output: z.number().int().positive().max(100_000_000).optional(),
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

const positive = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined);

/**
 * The token limits an OpenAI-compatible `GET /models` reports, by model id:
 * `context_window` (Morph and others), `max_model_len` (vLLM), `context_length`
 * (OpenRouter). Empty when the endpoint does not answer or reports none.
 */
export async function probeCustomModelLimits(baseUrl: string, apiKey: string | null): Promise<Map<string, ModelLimits>> {
  const out = new Map<string, ModelLimits>();
  try {
    const res = await safeEgressFetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(5_000),
      maxRedirects: 0,
      allowHttp: true,
      allowPrivateHosts: config.KORTIX_LLM_CUSTOM_PROVIDER_ALLOW_HOSTS,
    });
    if (!res.ok) return out;
    const body = await res.json() as { data?: Record<string, any>[] };
    for (const model of Array.isArray(body?.data) ? body.data : []) {
      if (typeof model?.id !== 'string') continue;
      const context = positive(model.context_window) ?? positive(model.max_model_len) ?? positive(model.context_length)
        ?? positive(model.top_provider?.context_length);
      const output = positive(model.max_output_tokens) ?? positive(model.max_completion_tokens)
        ?? positive(model.top_provider?.max_completion_tokens);
      if (context || output) out.set(model.id, { context, output });
    }
  } catch {
    // A dead or slow endpoint saves anyway; its models get the default window.
  }
  return out;
}

/** {@link probeCustomModelLimits} with the provider's saved key, read as the saving user. */
export async function detectCustomModelLimits(
  input: { projectId: string; accountId: string; userId: string; providerId: string; baseUrl: string },
): Promise<Map<string, ModelLimits>> {
  const [key] = await resolveProjectSecretsForConsumer({
    projectId: input.projectId, accountId: input.accountId, actorUserId: input.userId,
    name: customProviderSecretName(input.providerId), consumer: 'llm_gateway',
  });
  return probeCustomModelLimits(input.baseUrl, key?.value ?? null);
}

/** The list with `id` replaced (or appended), sorted by id. A limit in the input wins over `detected`. */
export function upsertCustomProvider(
  list: CustomLlmProviderDefinition[],
  id: string,
  input: CustomLlmProviderInput,
  detected: Map<string, ModelLimits> = new Map(),
): CustomLlmProviderDefinition[] {
  const bare = (modelId: string) => (modelId.startsWith(`${id}/`) ? modelId.slice(id.length + 1) : modelId);
  const models = [...new Map(input.models.map((m) => [bare(m.id), m])).entries()].map(([modelId, m]) => {
    const context = m.context ?? detected.get(modelId)?.context;
    const output = m.output ?? detected.get(modelId)?.output;
    return { id: modelId, name: m.name, ...(context ? { context } : {}), ...(output ? { output } : {}) };
  });
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
        // The endpoint's own limits; 128k/16k only when it reports none. pi clamps `max_tokens` to the
        // room left in the window and OpenCode caps it at 32k, so output = context is safe.
        limit: { context: model.context ?? 128_000, output: model.output ?? model.context ?? 16_000 },
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
