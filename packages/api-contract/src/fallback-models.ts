/**
 * The model fallback table OpenCode's `kortix` provider falls back to inside
 * the sandbox. Data only, with no imports: kortixd bundles it. It holds no
 * Kortix managed model: those come only from the API, which reads them from
 * Platinum Inference.
 */

/**
 * The `max_tokens` ceiling kortixd gives OpenCode
 * (`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`). OpenCode clamps to 32,000 by
 * default; a clamp below a managed model's `limit.output` cuts a large file
 * write at finish_reason "length" and the tool never runs.
 */
export const MANAGED_OPENCODE_OUTPUT_TOKEN_MAX = 65_536
// One `reasoning_options` entry (models.dev's shape, mirrored — see
// @kortix/llm-catalog's CatalogReasoningOption). Present iff the model
// exposes a tunable reasoning-effort knob; this is the PRIORITY field the
// chat runtime/composer's effort control reads off the model opencode
// registers, so it must survive the full gateway -> opencode hop intact.
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
  // 'openai', 'codex', 'kortix', ...). Every model here is registered under
  // the single synthetic `kortix` opencode provider (see buildKortixProvider
  // below) — this is what the web picker groups/brands by instead of
  // string-splitting the wire model id (see model-selector.tsx's
  // pickerGroupId / use-model-store.ts's subProviderOf).
  provider?: string
  reasoning?: boolean
  reasoning_options?: KortixReasoningOption[]
  // Explicit OpenCode variant map (id → request overlay). Present when the
  // catalog ships one; otherwise derived from `reasoning_options` at config
  // build (see variantsFromReasoningOptions).
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

export const MINIMAL_FALLBACK_MODELS: Record<string, KortixGatewayModel> = {
  'openai/gpt-5.5': {
    name: 'GPT-5.5',
    provider: 'openai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    // models.dev: false — OpenAI reasoning models (gpt-5.x) reject a
    // client-sent `temperature`, so advertising support here would make
    // OpenCode send one and 400 the turn whenever this fallback catalog is
    // in effect. Must match capabilitiesOf() in the served catalog
    // (apps/api/src/llm-gateway/models/catalog-models.ts).
    temperature: false,
    limit: { context: 1_050_000, output: 64_000 },
  },
  'google/gemini-3.5-flash': {
    name: 'Gemini 3.5 Flash',
    provider: 'google',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'google/gemini-3.1-pro-preview': {
    name: 'Gemini 3.1 Pro',
    provider: 'google',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 65_536 },
  },
  'deepseek/deepseek-v4-flash': {
    name: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'deepseek/deepseek-v4-pro': {
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'minimax/minimax-m3': {
    name: 'MiniMax M3',
    provider: 'minimax',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_048_576, output: 64_000 },
  },
  'moonshotai/kimi-k2.6': {
    name: 'Kimi K2.6',
    provider: 'moonshotai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 262_144, output: 64_000 },
  },
  'z-ai/glm-5.1': {
    name: 'GLM 5.1',
    provider: 'z-ai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 202_752, output: 64_000 },
  },
  'x-ai/grok-4.3': {
    name: 'Grok 4.3',
    // models.dev's real provider id is 'xai' (no hyphen) — matches
    // @kortix/llm-catalog's PROVIDER_LABELS key and gatewayModelsAll's
    // `provider` field. The model-id PREFIX here ('x-ai/...') is just this
    // fallback table's own key convention and is left alone; only the
    // `provider` value (what the picker actually groups/labels by) must
    // match models.dev's real id or the picker mislabels/falls back to
    // "Kortix" for this entry.
    provider: 'xai',
    reasoning: true,
    tool_call: true,
    attachment: true,
    temperature: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
}
