import { MANAGED_MODELS as BUNDLED_MANAGED_MODELS, type ManagedModel } from '@kortix/llm-catalog';
import { z } from 'zod';
import { config } from '../../config';

const managedModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  upstreamModelId: z.string().min(1),
  transport: z.literal('openrouter'),
  providerBrand: z.string().min(1).optional(),
  pricingRef: z.string().min(1),
  pricing: z
    .object({
      inputPerMillion: z.number().nonnegative(),
      outputPerMillion: z.number().nonnegative(),
      cachedInputPerMillion: z.number().nonnegative().optional(),
      cacheWritePerMillion: z.number().nonnegative().optional(),
      contextOver200k: z
        .object({
          inputPerMillion: z.number().nonnegative(),
          outputPerMillion: z.number().nonnegative(),
          cachedInputPerMillion: z.number().nonnegative().optional(),
          cacheWritePerMillion: z.number().nonnegative().optional(),
          contextThreshold: z.number().int().positive(),
        })
        .optional(),
    })
    .optional(),
  tier: z.enum(['flagship', 'balanced', 'fast']),
  vision: z.boolean(),
  limit: z.object({
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  }),
  openrouterProvider: z.object({
    only: z.tuple([z.string().min(1)]),
    allow_fallbacks: z.literal(false),
    zdr: z.literal(true),
    data_collection: z.literal('deny'),
  }),
});

export function parseManagedModels(
  raw: string | undefined,
  fallback: readonly ManagedModel[] = BUNDLED_MANAGED_MODELS,
): ManagedModel[] {
  if (!raw) return [...fallback];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `LLM_GATEWAY_MANAGED_MODELS must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const models = z.array(managedModelSchema).parse(parsed) as ManagedModel[];
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      throw new Error(`LLM_GATEWAY_MANAGED_MODELS contains duplicate model id "${model.id}"`);
    }
    ids.add(model.id);
  }
  return models;
}

/**
 * Kortix-credit managed models. This registry is empty
 * when the cloud managed-provider flag is off. The picker, catalog, and gateway
 * all use this registry, so self-host users never receive the shared key.
 */
export const RUNTIME_MANAGED_MODELS: readonly ManagedModel[] =
  config.KORTIX_MANAGED_PROVIDER_ENABLED
    ? parseManagedModels(config.LLM_GATEWAY_MANAGED_MODELS)
    : [];

const MANAGED_BY_ID = new Map(RUNTIME_MANAGED_MODELS.map((model) => [model.id, model] as const));

export function getRuntimeManagedModel(id: string): ManagedModel | undefined {
  return MANAGED_BY_ID.get(id);
}

export function isRuntimeManagedModelId(id: string): boolean {
  return MANAGED_BY_ID.has(id);
}

// The BUNDLED catalog (never gated by KORTIX_MANAGED_PROVIDER_ENABLED) — used
// only to answer "is this id a REAL managed-model id at all", regardless of
// whether the managed provider happens to be enabled on this deployment.
// RUNTIME_MANAGED_MODELS/MANAGED_BY_ID above are empty whenever the flag is
// off, so they can't tell "self-host operator hasn't turned this on" apart
// from "no such model exists anywhere" — this can, which lets gateway error
// messaging say "this model needs the managed provider, which is off here"
// instead of the misleading "no such model".
const BUNDLED_BY_ID = new Map(BUNDLED_MANAGED_MODELS.map((model) => [model.id, model] as const));
const RETIRED_MANAGED_MODEL_IDS = new Set([
  'glm-5.2', 'grok-4.6', 'deepseek-v4-flash',
  'muse-spark-1.2', 'minimax-m3', 'gpt-5.6-luna', 'gpt-6-astra',
  'morph-glm53-744b', 'morph-dsv4flash', 'morph-kimik3',
  'morph-kimik3-fast', 'morph-dsv41flash',
  'deepseek-v4-flash-0731', 'kimi-k3-fast',
]);

const LEGACY_MANAGED_IDS: Record<string, string> = {
  'morph-kimik3': 'kimi-k3',
  'morph-kimik3-fast': 'kimi-k3-fast',
  'morph-dsv41flash': 'deepseek-v4.1-flash',
  'morph-dsv4flash': 'deepseek-v4-flash-0731',
  'deepseek-v4-flash': 'deepseek-v4-flash-0731',
};

export function canonicalManagedModelId(id: string): string {
  return LEGACY_MANAGED_IDS[id] ?? id;
}

export function isKnownManagedModelId(id: string): boolean {
  return BUNDLED_BY_ID.has(id) || RETIRED_MANAGED_MODEL_IDS.has(id);
}

/**
 * The managed lineup this deployment can actually SERVE: every configured model
 * whose transport credential is present. `hasTransportCredential` is injected so
 * the rule stays pure and testable without config.
 *
 * `RUNTIME_MANAGED_MODELS` answers "which models did the operator configure",
 * which is not the same question. Offering a configured-but-uncredentialed model
 * can make the picker advertise a model while every selection of it fails.
 */
export function servedManagedModels(
  models: readonly ManagedModel[],
  hasTransportCredential: (model: ManagedModel) => boolean,
): ManagedModel[] {
  return models.filter(hasTransportCredential);
}

/** Strip the opencode `kortix/` namespace off a managed ref. */
function bareManagedId(ref: string): string {
  return ref.startsWith('kortix/') ? ref.slice('kortix/'.length) : ref;
}

/**
 * The platform default model, guaranteed reachable.
 *
 * `LLM_GATEWAY_DEFAULT_MODEL` is what an operator asked for; it is not
 * necessarily servable. When the configured default is a managed id this
 * deployment cannot reach because its transport credential is absent, every
 * `auto` request and every "use the default" pick
 * dies with a resolution error the user cannot act on. Degrade to a served
 * managed model instead — flagship first, then catalog order.
 *
 * A BYOK ref (`provider/model`) is returned untouched: it resolves from a
 * PROJECT key, so a managed transport says nothing about whether it works, and
 * `degradeUnservableDefault` already probes that case per-project.
 */
export function resolvePlatformDefaultModelId(
  configured: string,
  served: readonly ManagedModel[],
): string {
  const trimmed = configured.trim();
  if (!trimmed) return trimmed;
  const bare = bareManagedId(trimmed);
  const alias = canonicalManagedModelId(bare);
  if (alias !== bare && served.some((model) => model.id === alias)) return alias;
  // Not a managed id at all → a BYOK ref; leave it alone.
  if (!isKnownManagedModelId(bare)) return trimmed;
  if (served.some((model) => model.id === bare)) return trimmed;
  const replacement = served.find((model) => model.tier === 'flagship') ?? served[0];
  return replacement ? replacement.id : trimmed;
}

export type { ManagedModel };
