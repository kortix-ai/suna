/**
 * The model fallback table OpenCode's `kortix` provider falls back to, and its
 * managed subset. Data only, with no imports: apps/api imports this file to
 * keep the managed lineup and the fallback in sync
 * (llm-gateway/models/managed-fallback-sync.test.ts), and a leaf keeps the
 * rest of the daemon out of apps/api's typecheck.
 */
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
  'deepseek-v4.1-flash': {
    name: 'DeepSeek V4.1 Flash', provider: 'kortix', reasoning: true, tool_call: true,
    attachment: true, temperature: true, modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high', 'max'] }],
    limit: { context: 1_048_576, output: 16_384 }, cost: { input: 0.2, output: 0.65, cache_read: 0.03 },
  },
  'glm-5.3-flash': {
    name: 'GLM 5.3 Flash', provider: 'kortix', reasoning: true, tool_call: true,
    attachment: true, temperature: true, modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
    limit: { context: 1_048_576, output: 16_384 }, cost: { input: 0.15, output: 0.5, cache_read: 0.05 },
  },
  'kimi-k3': {
    name: 'Kimi K3 2.8T', provider: 'kortix', reasoning: true, tool_call: true,
    attachment: true, temperature: true, modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
    limit: { context: 1_048_576, output: 16_384 }, cost: { input: 3.3, output: 16.5, cache_read: 0.33 },
  },
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

/** The managed subset of the bundled fallback table: bare ids branded `kortix`.
 *  Used when the live managed fetch is unavailable, so a managed model is
 *  present in OpenCode's provider map even with a stale baked catalog AND a
 *  down gateway. Kept in sync with @kortix/llm-catalog MANAGED_MODELS by
 *  apps/api/src/llm-gateway/models/managed-fallback-sync.test.ts — a managed model missing here and
 *  missing from the baked image is the exact 2026-08-19 ModelNotFound outage. */
export const BUNDLED_MANAGED_MODELS: Record<string, KortixGatewayModel> = Object.fromEntries(
  Object.entries(MINIMAL_FALLBACK_MODELS).filter(
    ([id, model]) => !id.includes('/') && model.provider === 'kortix',
  ),
)
