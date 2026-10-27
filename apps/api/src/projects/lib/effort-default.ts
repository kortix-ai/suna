/**
 * The project default reasoning effort (`projects.metadata.default_reasoning_effort`).
 *
 * One project-level effort choice that every prompt the platform delivers
 * carries when the caller named none — the composer's "Auto", a Slack
 * message, a trigger fire, a scheduled send. An explicit session pick (the
 * composer's variant radio, a trigger's own variant) always wins: injection
 * happens only when the prompt carries no `variant` at all.
 *
 * Storage is `projects.metadata` (no migration — the jsonb already exists,
 * same mechanism as `metadata.onboarding_completed_at`), written by
 * `PUT /v1/projects/:projectId/default-reasoning-effort`.
 *
 * The value is a models.dev effort label (`low`, `high`, `xhigh`, …). The
 * effort ladder is PER MODEL — gpt-5.6-sol publishes `xhigh`, a Claude model
 * synthesizes low/medium/high from its token budget — so a stored default is
 * CLAMPED to the serving model's own options before it rides a prompt
 * (`clampGenerationConfig`, the same gate the routing-policy write path and
 * the gateway resolution layer run). A value the model doesn't publish is
 * dropped for that prompt, never sent: the gateway refuses an unknown effort
 * with a 400, and OpenCode would apply nothing — a mis-chosen default must
 * never break a turn.
 */
import {
  CATALOG,
  clampGenerationConfig,
  generationControlCapabilities,
  type CatalogModel,
} from '@kortix/llm-catalog';
import { catalogModelForWireModel } from '../../llm-gateway/models/catalog-models';
import { toWireModel } from '../../llm-gateway/resolution/effective';

export const DEFAULT_REASONING_EFFORT_METADATA_KEY = 'default_reasoning_effort';

/**
 * Every effort label the catalog can turn into a real sendable choice —
 * the write-time vocabulary. Derived, never hardcoded: the catalog-data
 * convention forbids inventing a literal union for an upstream enum (the
 * ladder grows; a hardcoded copy goes stale). `generationControlCapabilities`
 * maps each model's `reasoning_options` to the values its effort control can
 * offer — the model's own enum for an `effort` entry, the synthesized
 * low/medium/high tiers for a `budget_tokens` entry (every mainline Claude
 * model), nothing for a bare `toggle`. A model-specific value that is in this
 * set but not in a particular model's own options is still rejected per
 * prompt by the clamp.
 */
export const KNOWN_EFFORT_VALUES: ReadonlySet<string> = (() => {
  const values = new Set<string>();
  for (const provider of CATALOG.providers) {
    for (const model of provider.models) {
      for (const value of generationControlCapabilities(model).reasoningEffort?.values ?? []) {
        values.add(value);
      }
    }
  }
  return values;
})();

/** Validated on read AND write: a value the catalog never published (or one
 *  written directly to the DB) never reaches a client or a prompt. */
export function normalizeDefaultReasoningEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return KNOWN_EFFORT_VALUES.has(trimmed) ? trimmed : null;
}

/** The wire model a prompt would run on: the prompt's own model override
 *  (`{providerID, modelID}`, the form every client sends), else the session's
 *  stored pin (`metadata.opencode_model`, the `kortix/<wire>` ref form or a
 *  native `provider/model`). `null` when neither names a model the platform
 *  knows — the runtime's own default then applies, and the clamp has nothing
 *  to check the value against. */
export function promptWireModel(
  override: { providerID?: string; modelID?: string } | null | undefined,
  sessionModelRef: unknown,
): string | null {
  if (override?.providerID && override?.modelID) {
    return toWireModel(`${override.providerID}/${override.modelID}`);
  }
  if (typeof sessionModelRef === 'string' && sessionModelRef.length > 0) {
    return toWireModel(sessionModelRef);
  }
  return null;
}

/**
 * The variant a prompt should carry because of the project default — or
 * `undefined` when none applies. `undefined` (not `null`) so the caller can
 * spread it into the overrides without adding a `variant: null` key: an
 * explicit pick is checked BEFORE this helper runs and never reaches it.
 */
export function effortVariantForPrompt(params: {
  stored: unknown;
  modelOverride?: { providerID?: string; modelID?: string } | null;
  sessionModelRef?: unknown;
  /** Override the catalog lookup in tests. */
  resolveCatalogModel?: (wireModel: string) => CatalogModel | undefined;
}): string | undefined {
  const stored = normalizeDefaultReasoningEffort(params.stored);
  if (!stored) return undefined;
  const wire = promptWireModel(params.modelOverride, params.sessionModelRef);
  if (!wire) return undefined;
  const model = params.resolveCatalogModel
    ? params.resolveCatalogModel(wire)
    : catalogModelForWireModel(wire);
  if (!model) return undefined;
  return clampGenerationConfig({ reasoningEffort: stored }, model).reasoningEffort ?? undefined;
}
