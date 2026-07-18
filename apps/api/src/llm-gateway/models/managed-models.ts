import { MANAGED_MODELS as BUNDLED_MANAGED_MODELS, type ManagedModel } from '@kortix/llm-catalog';
import { z } from 'zod';
import { config } from '../../config';

const managedModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  upstreamModelId: z.string().min(1),
  transport: z.enum(['bedrock', 'openrouter']),
  pricingRef: z.string().min(1),
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
 * must never see or route to Kortix's shared Bedrock/OpenRouter credentials.
 * This is the single choke point: every consumer (the served model catalog,
 * the picker, and request-time routing) reads through here or getRuntimeManagedModel()
 * below, so gating it here alone keeps the managed lineup off everywhere.
 *
 * IMPORTANT — what the "managed provider" IS and IS NOT (a recurring
 * misconception): KORTIX_MANAGED_PROVIDER_ENABLED is a CLOUD-ONLY CONVENIENCE
 * so cloud users can spend their KORTIX CREDITS for a zero-config experience —
 * it routes to Kortix's OWN shared Bedrock/OpenRouter credentials, billed as
 * credits. It is NOT the mechanism by which "Bedrock" (or OpenRouter, or any
 * provider) is available. Bedrock is a STANDALONE provider in its own right —
 * exactly like OpenRouter/OpenAI/Anthropic — that a project uses by connecting
 * its OWN credentials (BYOK). To give a self-host Bedrock you connect Bedrock
 * as a standalone BYOK provider (project secret AWS_BEARER_TOKEN_BEDROCK →
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

export type { ManagedModel };
