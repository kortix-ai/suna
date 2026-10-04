import { MANAGED_MODELS as BUNDLED_MANAGED_MODELS, type ManagedModel } from '@kortix/llm-catalog';
import { z } from 'zod';
import { config } from '../../lib/config';

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
  morphModelId: z.string().min(1).optional(),
  morphPricing: z.object({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative().optional(),
  }).optional(),
  // `only` is required: OpenRouter may fall back only inside this endpoint pool.
  openrouterProvider: z.object({
    only: z.array(z.string().min(1)).min(1),
    allow_fallbacks: z.boolean(),
    zdr: z.literal(true),
    data_collection: z.literal('deny'),
    max_price: z
      .object({ prompt: z.number().nonnegative(), completion: z.number().nonnegative() })
      .optional(),
  }),
}).refine((model) => Boolean(model.morphModelId) === Boolean(model.morphPricing), {
  message: 'morphModelId and morphPricing must be set together',
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
  'glm-5.2', 'grok-4.6', 'deepseek-v4-flash', 'deepseek-v4-pro-0813',
  'muse-spark-1.2', 'minimax-m3', 'gpt-5.6-luna', 'gpt-6-astra',
  'morph-glm53-744b', 'morph-dsv4flash', 'morph-kimik3',
  'morph-kimik3-fast', 'morph-dsv41flash',
  'deepseek-v4-flash-0731', 'kimi-k3-fast',
]);

// Exported (read-only) so a test can iterate every declared alias and assert
// its FULLY RESOLVED chain lands on something still current — the guard
// against the exact bug this map just had: an alias whose one-hop target got
// retired out from under it and nobody revisited the alias.
export const LEGACY_MANAGED_IDS: Readonly<Record<string, string>> = {
  'morph-kimik3': 'kimi-k3',
  'morph-kimik3-fast': 'kimi-k3-fast',
  'morph-dsv41flash': 'deepseek-v4.1-flash',
  'morph-dsv4flash': 'deepseek-v4-flash-0731',
  'deepseek-v4-flash': 'deepseek-v4-flash-0731',
  // deepseek-v4-flash-0731 was itself retired 2026-09-28 in favor of
  // deepseek-v4.1-flash — see RETIRED_MANAGED_MODEL_IDS above.
  'deepseek-v4-flash-0731': 'deepseek-v4.1-flash',
  // kimi-k3-fast (the ONE-HOP target of morph-kimik3-fast above) is itself
  // retired — the fast tier merged into kimi-k3. Found by the chain-
  // resolution guard test below, 2026-09-28, the same bug class as
  // deepseek-v4-flash-0731 above: a target retired out from under its alias.
  'kimi-k3-fast': 'kimi-k3',
};

// Bounds chain resolution below. This map is hand-maintained: retiring a
// model whose id is itself the TARGET of an older alias (deepseek-v4-flash-
// 0731 was both — see the two entries above it) creates a two-hop chain, and
// nothing stops a third. A bound plus cycle detection means a data bug here
// degrades to "stop resolving" rather than hanging a turn.
const CANONICAL_CHAIN_MAX_HOPS = 8;

/**
 * Follows `table` to its end, not just one hop — a retired id can itself be
 * superseded (deepseek-v4-flash-0731 was the declared successor for
 * morph-dsv4flash/deepseek-v4-flash, then was itself retired in favor of
 * deepseek-v4.1-flash; a single lookup would leave those two aliases pointing
 * at a now-also-retired id). Stops at the first id that is not itself a key,
 * or after `maxHops` hops, or the instant a hop would repeat an id already
 * seen (a cycle) — whichever comes first. `table` is injected so this stays
 * pure and testable against a synthetic chain/cycle without mutating the real
 * (hand-maintained) map. The caller-side retirement checks (resolve-
 * candidates.ts, session-model-repoint.ts) still treat a not-fully-resolved
 * retired id correctly, so stopping early here is safe: it never fabricates a
 * wrong answer, only leaves one still-retired.
 */
export function resolveLegacyIdChain(
  id: string,
  table: Readonly<Record<string, string>>,
  maxHops: number = CANONICAL_CHAIN_MAX_HOPS,
): string {
  let current = id;
  const seen = new Set([current]);
  for (let hop = 0; hop < maxHops; hop++) {
    const next = table[current];
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
  return current;
}

export function canonicalManagedModelId(id: string): string {
  return resolveLegacyIdChain(id, LEGACY_MANAGED_IDS);
}

export function isKnownManagedModelId(id: string): boolean {
  return BUNDLED_BY_ID.has(id) || RETIRED_MANAGED_MODEL_IDS.has(id);
}

/** Explicitly retired — distinct from merely "not currently servable" (off
 *  deployment / missing credential), which stays a bundled-but-unserved id. */
export function isRetiredManagedModelId(id: string): boolean {
  return RETIRED_MANAGED_MODEL_IDS.has(id);
}

/**
 * The declared successor for a retired id, ONLY when that successor is
 * itself in `served` — never a dead pin swapped for another dead pin.
 * `null` when the id isn't retired, has no declared successor
 * (LEGACY_MANAGED_IDS), or the successor isn't servable here either.
 */
export function retiredManagedModelReplacement(id: string, served: readonly ManagedModel[]): string | null {
  if (!isRetiredManagedModelId(id)) return null;
  const successor = canonicalManagedModelId(id);
  return successor !== id && served.some((model) => model.id === successor) ? successor : null;
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
