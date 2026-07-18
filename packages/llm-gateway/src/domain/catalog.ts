// One entry of models.dev's `reasoning_options` (mirrors
// `@kortix/llm-catalog`'s `CatalogReasoningOption` — duplicated rather than
// imported so this package stays dependency-free of `@kortix/llm-catalog`;
// keep the shape identical).
export interface ModelReasoningOption {
  type: string;
  values: string[];
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
}

export type ModelCatalog = Record<string, ModelInfo>;
