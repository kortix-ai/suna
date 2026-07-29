import { defaultEnabledModelIds } from '@kortix/llm-catalog';

import { config } from '../config';
import { getProjectRoutingPolicy } from '../repositories/project-routing-policies';

// Per-project model enablement. The newest model of each family is offered by
// default; a project stores only the EXCEPTIONS it made to that. Anything not
// effectively enabled is refused everywhere (chat, Slack, triggers, raw API)
// and hidden from the session picker.
//
//     enabled(id) = overrides[id] ?? defaultEnabledModelIds(catalog).has(id)
//
// Keeping the default in the formula (rather than resolving it into a stored
// set) is what makes "the latest models are on" stay true as the catalog moves
// — connect a new provider, or ship a new Claude, and it is offered without
// anyone clicking anything.
//
// This module is the ONLY place that resolves overrides + default into an
// answer, so the gateway and both UI surfaces can never disagree.
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
 * The models a catalog offers by default: reduced to the newest per family.
 * Takes the catalog rather than fetching one so each caller defaults over
 * exactly the models it is answering about — the picker route narrows by
 * connected providers and plan, the gateway judges against everything routable.
 */
export function defaultEnabledFromCatalog(catalog: Record<string, ServedModel>): Set<string> {
  return defaultEnabledModelIds(
    Object.entries(catalog).map(([id, model]) => ({
      id,
      released: model.released ?? model.release_date,
      family: model.family,
      provider: model.provider,
    })),
  );
}

/**
 * Resolve enablement for a whole catalog at once: `wireModelId -> enabled`.
 * The picker route serves this verbatim so clients never recompute it.
 */
export function resolveEnablement(
  catalog: Record<string, ServedModel>,
  overrides: ModelOverrides,
): Map<string, boolean> {
  // Feature off is a kill switch, not a mode: everything is offered, and the
  // gateway's check below agrees. Both halves read the flag so the picker can
  // never show a model the gateway would refuse, or vice versa.
  if (!config.MODEL_ENABLEMENT_ENABLED) {
    return new Map(Object.keys(catalog).map((id) => [id, true]));
  }
  const byDefault = defaultEnabledFromCatalog(catalog);
  return new Map(Object.keys(catalog).map((id) => [id, overrides[id] ?? byDefault.has(id)]));
}

/**
 * True when `projectId` offers `wireModel`. Always true when there's no project
 * to scope the overrides to — enablement simply doesn't apply, which must never
 * read as "refuse everything".
 */
export async function isModelEnabledForProject(
  projectId: string | null | undefined,
  wireModel: string,
  catalog: Record<string, ServedModel>,
): Promise<boolean> {
  if (!config.MODEL_ENABLEMENT_ENABLED || !projectId) return true;
  const policy = await getProjectRoutingPolicy(projectId);
  const override = policy?.modelOverrides?.[wireModel];
  if (override !== undefined) return override;
  return defaultEnabledFromCatalog(catalog).has(wireModel);
}
