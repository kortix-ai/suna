// One entry of models.dev's `reasoning_options` (mirrors
// `@kortix/llm-catalog`'s `CatalogReasoningOption` — kept as a local shape for
// this domain's descriptor capability flags; keep it identical). This package
// DOES depend on `@kortix/llm-catalog` now (the ai-sdk transport reuses its
// canonical `clampGenerationConfig`/`catalogModelForWireModel` to gate
// per-request generation params — see transports/ai-sdk/request.ts), so this
// duplication is no longer a dependency-avoidance measure; it just avoids
// coupling this domain type to the catalog's evolving surface. Three real
// shapes: `effort` (values), `toggle`
// (neither), `budget_tokens` (min/max, no values — this is mainline
// Anthropic's shape). All fields but `type` are optional so every shape
// round-trips through this type without narrowing.
export interface ModelReasoningOption {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}

export interface ModelCostTier {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tier?: { type: string; size: number };
}

export interface ModelCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: ModelCostTier[];
  context_over_200k?: ModelCostTier;
}

export interface ModelModalities {
  input?: string[];
  output?: string[];
}

export interface ModelInfo {
  name: string;
  // The REAL upstream provider this model resolves against — 'anthropic',
  // 'openai', 'codex' (ChatGPT subscription), 'kortix' (managed/auto), etc.
  // Every wire model served by the gateway is registered under the single
  // synthetic `kortix` opencode provider (see the sandbox agent server's
  // `buildKortixProvider`), so this is the one field a client can group/brand
  // by WITHOUT parsing the wire model id — never drop it; a client that has
  // to fall back to string-splitting `<provider>/<model>` is exactly the
  // fragile path this field exists to replace.
  provider?: string;
  reasoning?: boolean;
  // Present iff the model exposes a tunable reasoning-effort knob — see
  // `@kortix/llm-catalog`'s `CatalogReasoningOption` (identical shape).
  reasoning_options?: ModelReasoningOption[];
  tool_call?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  structured_output?: boolean;
  // Training data cutoff (models.dev's free-text field, e.g. "2026-02-16").
  knowledge?: string;
  // Model family/lineage grouping (e.g. "gpt-sol", "claude-4", "o").
  family?: string;
  modalities?: ModelModalities;
  limit?: { context?: number; input?: number; output?: number };
  cost?: ModelCost;
  // Free-text blurb models.dev publishes for the model (e.g. picker
  // tooltips). Threaded end-to-end alongside the other capability fields —
  // never stop at the catalog layer.
  description?: string;
  // True when the model's weights are publicly released (open-weights model)
  // vs. a closed API-only model. models.dev's `open_weights` field, mirrored.
  open_weights?: boolean;
  // When models.dev last refreshed this model's own entry (distinct from
  // `released`, the model's original release date).
  last_updated?: string;
}

export type ModelCatalog = Record<string, ModelInfo>;
