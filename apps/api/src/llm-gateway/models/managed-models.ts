import { MANAGED_MODELS as BUNDLED_MANAGED_MODELS, type ManagedModel } from '@kortix/llm-catalog';
import { z } from 'zod';
import { config } from '../../config';

const managedModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  upstreamModelId: z.string().min(1),
  transport: z.enum(['aster', 'bedrock', 'openrouter']),
  providerBrand: z.string().min(1).optional(),
  pricingRef: z.string().min(1),
  pricing: z.object({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative().optional(),
    cacheWritePerMillion: z.number().nonnegative().optional(),
  }).optional(),
  tier: z.enum(['flagship', 'balanced', 'fast']),
  vision: z.boolean(),
  limit: z.object({
    context: z.number().int().positive(),
    output: z.number().int().positive(),
  }),
  openrouterProvider: z.record(z.unknown()).optional(),
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
 * API/control-plane managed model overlay used by runtime routing and catalog
 * responses. CLOUD-ONLY: empty whenever KORTIX_MANAGED_PROVIDER_ENABLED is off
 * (the self-host default) — a self-host operator brings their own LLM keys and
 * must never see or route to Kortix's shared upstream credentials.
 * This is the single choke point: every consumer (the served model catalog,
 * the picker, and request-time routing) reads through here or getRuntimeManagedModel()
 * below, so gating it here alone keeps the managed lineup off everywhere.
 *
 * IMPORTANT — what the "managed provider" IS and IS NOT (a recurring
 * misconception): KORTIX_MANAGED_PROVIDER_ENABLED is a CLOUD-ONLY CONVENIENCE
 * so cloud users can spend their KORTIX CREDITS for a zero-config experience —
 * it routes to Kortix's own shared upstream credentials, billed as credits.
 * It is not the mechanism by which Bedrock or OpenRouter is available.
 * Bedrock is a standalone provider that a workspace uses by connecting
 * its OWN credentials (BYOK). To give a self-host Bedrock you connect Bedrock
 * as a standalone BYOK provider (workspace secret AWS_BEARER_TOKEN_BEDROCK →
 * resolveCatalogUpstream('amazon-bedrock') builds a kind:'bedrock' descriptor
 * via the normal BYOK path); you do NOT turn this flag on. This managed overlay
 * stays purely the cloud credits convenience.
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

export function isKnownManagedModelId(id: string): boolean {
  return BUNDLED_BY_ID.has(id);
}

/**
 * The managed lineup this deployment can actually SERVE: every configured model
 * whose transport credential is present. `hasTransportCredential` is injected so
 * the rule stays pure and testable without config.
 *
 * `RUNTIME_MANAGED_MODELS` answers "which models did the operator configure",
 * which is not the same question. Offering a configured-but-uncredentialed model
 * is what made the picker advertise `glm-5.2` while every selection of it 400'd.
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
 * deployment cannot reach (its transport credential is absent — e.g. `glm-5.2`
 * with no ASTER_API_KEY), every `auto` request and every "use the default" pick
 * dies with a resolution error the user cannot act on. Degrade to a served
 * managed model instead — flagship first, then catalog order.
 *
 * A BYOK ref (`provider/model`) is returned untouched: it resolves from a
 * WORKSPACE key, so a managed transport says nothing about whether it works, and
 * `degradeUnservableDefault` already probes that case per-Workspace.
 */
export function resolvePlatformDefaultModelId(
  configured: string,
  served: readonly ManagedModel[],
): string {
  const trimmed = configured.trim();
  if (!trimmed) return trimmed;
  const bare = bareManagedId(trimmed);
  // Not a managed id at all → a BYOK ref; leave it alone.
  if (!isKnownManagedModelId(bare)) return trimmed;
  if (served.some((model) => model.id === bare)) return trimmed;
  const replacement = served.find((model) => model.tier === 'flagship') ?? served[0];
  return replacement ? replacement.id : trimmed;
}

export type { ManagedModel };
