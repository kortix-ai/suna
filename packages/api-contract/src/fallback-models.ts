/**
 * The gateway model entry the sandbox reads: kortixd registers each catalog
 * entry under the `kortix` provider (`createPiModels`, `harness/pi/model.ts`).
 * Types only, with no imports: kortixd bundles it. It holds no model list:
 * Kortix managed models come only from the API, which reads them from
 * Platinum Inference.
 */

// One `reasoning_options` entry (models.dev's shape, mirrored — see
// @kortix/llm-catalog's CatalogReasoningOption). Present iff the model
// exposes a tunable reasoning-effort knob; this is the PRIORITY field the
// chat runtime/composer's effort control reads off the model the runtime
// registers, so it must survive the full gateway -> runtime hop intact.
// Three real shapes — `effort` (values), `toggle` (neither), `budget_tokens`
// (min/max, no values — mainline Anthropic's shape) — all fields but `type`
// optional so every shape survives the hop unmodified.
export type KortixReasoningOption = { type: string; values?: string[]; min?: number; max?: number }

export type KortixCostTier = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tier?: { type: string; size: number }
}

export type KortixCost = {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  tiers?: KortixCostTier[]
  context_over_200k?: KortixCostTier
}

export type KortixModalities = { input?: string[]; output?: string[] }

export type KortixGatewayModel = {
  name: string
  // The REAL upstream provider this model resolves against ('anthropic',
  // 'openai', 'codex', 'kortix', ...). Every model is registered under the
  // single `kortix` provider (kortixd `createPiModels`) — this is what the web
  // picker groups/brands by instead of string-splitting the wire model id
  // (see `pickerGroupId` in packages/ui `model-grouping.ts` and
  // `subProviderOf` in packages/sdk `model-visibility.ts`).
  provider?: string
  reasoning?: boolean
  reasoning_options?: KortixReasoningOption[]
  // Explicit variant map (id → request overlay). Present when the catalog
  // ships one; otherwise derived from `reasoning_options` (kortixd
  // `variantsFromReasoningOptions`, `harness/shared/reasoning-variants.ts`).
  variants?: Record<string, Record<string, unknown>>
  tool_call?: boolean
  attachment?: boolean
  temperature?: boolean
  structured_output?: boolean
  knowledge?: string
  family?: string
  modalities?: KortixModalities
  limit?: { context?: number; input?: number; output?: number }
  cost?: KortixCost
  // Free-text blurb models.dev publishes for the model. Threaded through
  // like the rest of the enriched field set (was previously dropped between
  // the web catalog and the served/fallback gateway shapes).
  description?: string
  open_weights?: boolean
  last_updated?: string
}
