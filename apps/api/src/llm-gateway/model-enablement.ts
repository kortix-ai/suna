import { defaultEnabledModelIds } from '@kortix/llm-catalog';

import { isKnownManagedModelId } from './models/managed-models';

// Per-project model enablement. The newest model of each family is offered by
// default; a project stores only the EXCEPTIONS it made to that. Enablement is
// a DISPLAY contract: the picker hides a disabled model, but the gateway still
// serves it if a caller names it outright. The gateway must never refuse a
// request over enablement — that 400'd every turn on deployments whose in-use
// model the default rule had turned off (the #5932 revert).
//
//     enabled(id) = overrides[id] ?? defaultEnabledModelIds(catalog).has(id)
//
// Keeping the default in the formula (rather than resolving it into a stored
// set) is what makes "the latest models are on" stay true as the catalog moves
// — connect a new provider, or ship a new Claude, and it is offered without
// anyone clicking anything.
//
// This module is the ONLY place that resolves overrides + default into an
// answer, so no two UI surfaces can disagree.
//
// NOTE: distinct from ./enablement.ts, which resolves the `llm_gateway`
// experimental FEATURE flag — not model on/off.

/** Catalog metadata the default rule reads, as the models routes serve it. */
type ServedModel = {
  released?: string | null;
  release_date?: string | null;
  family?: string;
  provider?: string;
};

/** Per-project exceptions to the default: `wireModelId -> enabled`. */
export type ModelOverrides = Record<string, boolean>;

/**
 * The models a catalog offers by default: the newest per family, PLUS two sets
 * the recency rule must never prune.
 *
 * Takes the catalog rather than fetching one so each caller defaults over
 * exactly the models it is answering about — the picker route narrows by
 * connected providers and plan.
 *
 * `alwaysOn` is the models this project is CONFIGURED to use (its effective
 * default, vision model, fallbacks, routing-rule targets). Hiding one of those
 * would hide the model the project's own settings resolve to.
 */
export function defaultEnabledFromCatalog(
  catalog: Record<string, ServedModel>,
  alwaysOn: Iterable<string> = [],
): Set<string> {
  const enabled = defaultEnabledModelIds(
    Object.entries(catalog).map(([id, model]) => ({
      id,
      released: model.released ?? model.release_date,
      family: model.family,
      provider: model.provider,
    })),
  );
  for (const id of Object.keys(catalog)) {
    // Kortix-managed models are a small hand-curated set, not the models.dev
    // firehose the recency rule exists to tame — every one of them is in the
    // catalog precisely because we want it offered. Several (glm-5.2, the
    // PLATFORM DEFAULT) publish no release date or family at all, so the rule
    // would prune them and `auto` would resolve to a hidden model.
    if (isKnownManagedModelId(id)) enabled.add(id);
  }
  for (const id of alwaysOn) {
    if (catalog[id]) enabled.add(id);
  }
  return enabled;
}

/**
 * Resolve enablement for a whole catalog at once: `wireModelId -> enabled`.
 * The picker route serves this verbatim so clients never recompute it.
 */
export function resolveEnablement(
  catalog: Record<string, ServedModel>,
  overrides: ModelOverrides,
  alwaysOn: Iterable<string> = [],
): Map<string, boolean> {
  const byDefault = defaultEnabledFromCatalog(catalog, alwaysOn);
  return new Map(Object.keys(catalog).map((id) => [id, overrides[id] ?? byDefault.has(id)]));
}

/**
 * Models a routing policy points at, which the project is therefore configured
 * to route to. Hiding one of these would hide a model the project's own
 * routing rules produce.
 */
export function routingReferencedModels(
  policy: {
    visionModel?: string | null;
    defaultFallback?: { models: string[] } | null;
    rules?: Array<{ model: string; fallbackModels: string[] }>;
  } | null,
): string[] {
  if (!policy) return [];
  return [
    policy.visionModel,
    ...(policy.defaultFallback?.models ?? []),
    ...(policy.rules?.flatMap((rule) => [rule.model, ...rule.fallbackModels]) ?? []),
  ].filter((model): model is string => !!model);
}
