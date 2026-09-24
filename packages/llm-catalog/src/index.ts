import providerEnvJson from './provider-env.generated.json' with { type: 'json' };

export {
  DEFAULT_ENABLEMENT_WINDOW_MONTHS,
  defaultEnabledModelIds,
  type EnablementCandidate,
  autoSeedDefaultModel,
  autoSeedableModels,
  bedrockInferenceProfileRank,
} from './enablement';

// ─── Kortix-owned provider auth requirements ────────────────────────────────
//
// *** THE PROBLEM THIS FIXES ***
// `CatalogProvider.env` (models.dev's `env` field, in catalog.generated.json)
// lists EVERY env var the upstream's OFFICIAL SDK recognizes across ALL of
// that SDK's supported auth methods — not what KORTIX's own gateway
// transport actually reads. Most providers have exactly one implemented auth
// method, so `env` happens to be the right requirement as-is. A few don't:
//
//   - `amazon-bedrock`: models.dev lists BOTH the SigV4 access-key pair
//     (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) AND the bearer-token var
//     (AWS_BEARER_TOKEN_BEDROCK) plus AWS_REGION — because the AWS SDK
//     supports both. Kortix's bedrock transport
//     (packages/llm-gateway/src/transports/bedrock/request.ts) authenticates
//     ONLY with the bearer token; the BYOK resolver
//     (apps/api/src/llm-gateway/resolution/resolve-candidates.ts +
//     models/provider-registry.ts) reads ONLY AWS_BEARER_TOKEN_BEDROCK +
//     AWS_REGION. SigV4 signing is unimplemented (explicit
//     TODO(bedrock-sigv4) in request.ts). Treating all 4 vars as one AND-of-
//     everything requirement made a fully-working Bedrock connection show as
//     "not connected" and made the connect form demand 2 dead fields.
//
//   - `google`: models.dev lists three ALIASES for the same single credential
//     (GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY — all
//     three are recognized interchangeably by @ai-sdk/google). Requiring all
//     three together (the old AND-of-`env` behavior) made Google
//     unconnectable through the modal — nobody sets three key aliases to the
//     same value. Any ONE of them is sufficient.
//
// Providers NOT listed in the override map below have exactly one
// implemented method, taken straight from the catalog's `env` — this map
// only holds CORRECTIONS, so it stays small, and every entry must cite the
// transport code that justifies it (grep-able so it doesn't silently rot).
//
// *** THE MODEL ***
// A provider's real requirement is one or more independent auth METHODS
// (`ProviderAuthRequirement.methods`); a provider is "connected" when ANY
// method's env vars are ALL present (`isProviderAuthSatisfied`). This is
// deliberately more general than a flat env-var list so a provider can gain
// a second method later (e.g. Bedrock SigV4) without breaking existing
// connections on the first one — see the amazon-bedrock entry's comment.
//
// *** WHO USES THIS ***
// The single source of truth for BOTH "what fields does the connect form
// ask for" (always `methods[0]`, via `primaryAuthEnvVars`) and "is this
// provider connected" (`isProviderAuthSatisfied` over the FULL requirement)
// — in the web provider modal (apps/web/src/lib/llm-providers.ts,
// apps/web/src/hooks/opencode/provider-selection.ts), the SDK's native-mode
// provider merge (packages/sdk/src/react/provider-selection.ts), and the CLI
// (apps/cli/src/commands/providers.ts). All three derive from this module so
// they can't drift from each other or from what the gateway/transports
// actually read.
//
// *** AUDIT (2026-07-17) ***
// Checked every catalog provider with more than one `env` var against
// `packages/llm-gateway/src/catalog/compatibility.ts` (providerKindForNpm)
// and `apps/api/src/llm-gateway/resolution/*`. Besides bedrock/google above:
// azure, azure-cognitive-services, cloudflare-ai-gateway,
// cloudflare-workers-ai, databricks, google-vertex,
// google-vertex-anthropic, neon, privatemode-ai, and snowflake-cortex all
// list multiple env vars that are genuinely DIFFERENT-PURPOSE fields of one
// method (e.g. Vertex's project + location + credentials path) — real AND
// requirements, not alias/extra-method lists — and none of them has a
// gateway BYOK transport at all yet (providerKindForNpm returns null), so
// they're only ever used in native mode, where every listed var is read
// directly by the upstream SDK. No mismatch there; no override needed.
//
// NOTE: this package publishes dist/ via `tsc` with
// moduleResolution:"Bundler" (see tsconfig.build.json). Turbopack consumes the
// extensionless workspace source. `tsc-alias --resolve-full-paths` adds `.js`
// to the emitted relative import for plain Node ESM. The SDK install smoke
// imports the React entry and enforces the packed output.

export interface ProviderAuthMethod {
  /** Optional label, surfaced only if a provider ever exposes >1 method in the UI (none do today — the connect form always uses methods[0]). */
  label?: string;
  /** Every one of these project-secret env vars must be set for this method to count as satisfied. */
  envVars: string[];
}

export interface ProviderAuthRequirement {
  /**
   * One or more independent ways to authenticate. A provider is CONNECTED if
   * ANY method's envVars are all present — see `isProviderAuthSatisfied`.
   */
  methods: ProviderAuthMethod[];
}

interface CatalogProviderLike {
  id: string;
  env?: string[];
}

const PROVIDER_AUTH_REQUIREMENT_OVERRIDES: Record<string, ProviderAuthRequirement> = {
  'amazon-bedrock': {
    methods: [
      {
        label: 'Bearer token',
        // See the module doc comment above for the full trail. When SigV4
        // signing lands, ADD a second method here (e.g. `{ label: 'IAM
        // access key', envVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
        // 'AWS_REGION'] }`) — do not replace this one; existing bearer-token
        // connections must keep working.
        envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
      },
    ],
  },
  google: {
    methods: [
      // GOOGLE_GENERATIVE_AI_API_KEY first: the name @ai-sdk/google's own
      // docs lead with, and what Kortix's CLI/UI have always written when
      // connecting Google — kept as the connect form's primary field.
      { envVars: ['GOOGLE_GENERATIVE_AI_API_KEY'] },
      { envVars: ['GOOGLE_API_KEY'] },
      { envVars: ['GEMINI_API_KEY'] },
    ],
  },
};

/**
 * The auth requirement Kortix actually enforces for a catalog provider.
 * Falls back to a single method requiring every var in `provider.env`
 * (unchanged behavior) unless an override above corrects it.
 */
export function providerAuthRequirement(provider: CatalogProviderLike): ProviderAuthRequirement {
  const override = PROVIDER_AUTH_REQUIREMENT_OVERRIDES[provider.id];
  if (override) return override;
  const env = provider.env ?? [];
  return { methods: env.length > 0 ? [{ envVars: env }] : [] };
}

/**
 * The env vars the connect form should collect for a provider — always the
 * first (primary) auth method. Every provider has exactly one usable method
 * today; this is the field list `ApiKeyConnectForm` renders and writes.
 */
export function primaryAuthEnvVars(provider: CatalogProviderLike): string[] {
  return providerAuthRequirement(provider).methods[0]?.envVars ?? [];
}

/**
 * True when at least one of the requirement's auth methods has every one of
 * its env vars present, per `hasEnvVar`. ANY-OF-methods, ALL-OF-vars-within-
 * a-method — the one predicate every "is this provider connected" check
 * (web connect modal, model-selector gating, native-mode provider merge, CLI
 * `providers ls`) should use instead of hand-rolling `envVars.every(...)`
 * over the raw catalog list.
 */
export function isProviderAuthSatisfied(
  requirement: ProviderAuthRequirement,
  hasEnvVar: (envVar: string) => boolean,
): boolean {
  return requirement.methods.some(
    (method) => method.envVars.length > 0 && method.envVars.every(hasEnvVar),
  );
}

// One entry of models.dev's `reasoning_options` array. models.dev emits
// THREE real shapes today (verified against the live api.json, 2026-07):
//   - `{type:'effort', values:[...]}`       — a model-specific enum of effort
//     labels (e.g. gpt-5.6-sol's `["none","low","medium","high","xhigh","max"]`).
//     ~1522 models.
//   - `{type:'toggle'}`                     — reasoning is a plain on/off
//     switch, no enum/range. ~925 models.
//   - `{type:'budget_tokens', min?, max?}`  — a raw thinking-token budget
//     range, no discrete values. ~498 models, INCLUDING mainline Anthropic
//     (claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-1 and dated
//     variants all carry ONLY this shape — no `effort` entry at all).
// `values`/`min`/`max` are all OPTIONAL on one shared interface (rather than a
// strict discriminated union) so a 4th `type` models.dev adds later still
// round-trips through the catalog without a type change here — this mirrors
// the file's existing "never invent a literal union for an upstream enum"
// convention. MUST ingest every shape faithfully — filtering to
// `Array.isArray(values)` used to silently drop the toggle/budget_tokens
// shapes (57.8% of all models with reasoning_options, including every
// mainline Claude model). See `generationControlCapabilities` below for how
// each shape maps to a UI control.
export interface CatalogReasoningOption {
  type: string;
  values?: string[];
  min?: number;
  max?: number;
}

// A single price tier (models.dev's `cost.tiers[]` / `cost.context_over_200k`
// shape) — an alternate per-token price that applies once some threshold
// (currently always a context-size breakpoint) is crossed.
export interface CatalogCostTier {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tier?: { type: string; size: number };
}

export interface CatalogCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: CatalogCostTier[];
  context_over_200k?: CatalogCostTier;
}

export interface CatalogModalities {
  input?: string[];
  output?: string[];
}

export interface CatalogModel {
  id: string;
  name: string;
  released?: string | null;
  // models.dev lifecycle marker, mirrored verbatim ("active" | "deprecated"
  // | ... — models.dev adds values; absent means active). opencode hides
  // `deprecated` entries in the sandbox; every Kortix picker source that
  // stands in for the runtime must apply the same rule.
  status?: string;
  // Capabilities mirrored from models.dev by
  // apps/web/scripts/enrich-llm-catalog-capabilities.ts.
  // Single source of truth — consumers derive flags from these, never hardcode.
  // Free-text blurb models.dev publishes for the model (e.g. picker tooltips).
  description?: string;
  attachment?: boolean; // image / file input (vision)
  reasoning?: boolean;
  // Present only for reasoning-capable models that expose a tunable knob —
  // `[{type:'effort', values:[...]}]` today. A reasoning model with NO
  // entry here (reasoning:true, reasoning_options absent/empty) still
  // supports reasoning but doesn't publish a client-settable effort enum —
  // generationControlCapabilities below then exposes NO effort control for it
  // (we never fabricate effort values that models.dev doesn't advertise).
  reasoning_options?: CatalogReasoningOption[];
  tool_call?: boolean;
  // false means the model has a FIXED sampling temperature and rejects a
  // client-supplied one (e.g. gpt-5.6-sol) — never show/send a temperature
  // control for such a model.
  temperature?: boolean;
  structured_output?: boolean;
  // True when the model interleaves reasoning with tool calls (models.dev's
  // `interleaved` flag) — some reasoning models can emit a tool call mid
  // chain-of-thought rather than only after it completes. models.dev emits
  // TWO shapes for this field (verified against the live api.json,
  // 2026-07): a plain `boolean` (~34 models) AND an object like
  // `{field:'reasoning_content'}` naming the response field the interleaved
  // content arrives on (~623 models — the large majority). Filtering to
  // `typeof === 'boolean'` used to silently drop the object shape entirely;
  // both are ingested verbatim now.
  interleaved?: boolean | { field?: string };
  // True when the model's weights are publicly released (open-weights model,
  // e.g. a self-hostable Llama/DeepSeek/Qwen checkpoint) vs. a closed API-only
  // model. models.dev's `open_weights` field, mirrored verbatim.
  open_weights?: boolean;
  // Training data cutoff, models.dev's free-text field (e.g. "2026-02-16").
  knowledge?: string;
  // When models.dev last refreshed this model's own entry (distinct from
  // `released`, the model's original release date).
  last_updated?: string;
  // Model family/lineage grouping (e.g. "gpt-sol", "claude-4", "o").
  family?: string;
  modalities?: CatalogModalities;
  limit?: { context?: number; input?: number; output?: number };
  cost?: CatalogCost;
}

// ─── Generation controls — capability-gated, single source of truth ────────
//
// The one place that decides "which generation knobs does this model
// support, and what are their valid ranges" — consumed by BOTH the web UI
// (to show/hide/bound a control) and the gateway resolution layer (to decide
// which configured per-model default is safe to inject, and how to clamp
// it). Never hardcode a per-model exception outside this function; extend
// the capability derivation here instead so every consumer stays in sync.

/** Generic per-model generation defaults a project can configure. Extensible
 *  without a schema/migration change — see packages/db's jsonb column. */
export interface GenerationConfig {
  reasoningEffort?: string;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

export interface GenerationControlCapabilities {
  /**
   * Present iff the model publishes a REAL reasoning_options knob — from
   * EITHER an `effort` entry (its exact `values`) OR a `budget_tokens` entry
   * (a synthesized standard low/medium/high tier set — `budget_tokens` has no
   * discrete values of its own, but it IS a real published knob, e.g. every
   * mainline Claude model, which the transport maps via
   * `resolveAnthropicThinkingBudget`/`REASONING_EFFORT_BUDGET_TOKENS`
   * — so exposing an effort-style control for it is not fabrication the way
   * inventing one for a bare `reasoning:true` model with NO reasoning_options
   * at all would be). A `toggle` entry gets no control here (on/off is not an
   * effort enum) but does not crash — see the `toggle` branch below. Absent
   * entirely when the model publishes no real reasoning_options at all (we
   * never fabricate one out of thin air).
   */
  reasoningEffort?: { values: string[] };
  /** True iff the model accepts a client-supplied temperature (models.dev
   *  `temperature:false` means FIXED — e.g. gpt-5.6-sol — hide the control). */
  temperature: boolean;
  /** top_p has no distinct models.dev flag — gated on the same standard-
   *  sampling capability as temperature (documented heuristic: models that
   *  reject a custom temperature reject a custom top_p too). */
  topP: boolean;
  /** Present iff the model declares a positive max output-token window —
   *  the ceiling a "max output tokens" control must clamp to. */
  maxOutputTokens?: { ceiling: number };
}

// The standard effort tiers synthesized for a `budget_tokens`-shaped
// reasoning_options entry (no discrete `values` of its own to mirror). Chosen
// to match `REASONING_EFFORT_BUDGET_TOKENS`'s well-known low/medium/high keys
// (packages/llm-gateway/src/transports/ai-sdk/request.ts) so every value this
// control can offer resolves to a real thinking-token budget downstream —
// never an effort label the transport wouldn't know what to do with.
const BUDGET_TOKENS_EFFORT_TIERS = ['low', 'medium', 'high'] as const;

/** Pure capability derivation — NEVER a per-model id lookup table. */
export function generationControlCapabilities(
  model: CatalogModel | undefined | null,
): GenerationControlCapabilities {
  if (!model) return { temperature: false, topP: false };

  // Only expose an effort control when the model publishes a REAL
  // reasoning_options entry — never fabricate one for a model that publishes
  // none. Two shapes yield a control (see the field doc above): `effort`
  // (its own exact values) and `budget_tokens` (synthesized standard tiers —
  // it has no discrete values, but it's a real published knob, e.g. every
  // mainline Claude model). A `toggle` entry matches neither branch below and
  // falls through to `undefined` — deliberately: on/off isn't an effort enum,
  // and there's no separate toggle-control surface wired today, so this is
  // the "don't crash, don't fabricate" no-op for it.
  const effortOption = model.reasoning_options?.find((option) => option.type === 'effort');
  const budgetTokensOption = model.reasoning_options?.find(
    (option) => option.type === 'budget_tokens',
  );
  const reasoningEffort = effortOption?.values?.length
    ? { values: effortOption.values }
    : budgetTokensOption
      ? { values: [...BUDGET_TOKENS_EFFORT_TIERS] }
      : undefined;

  const temperature = model.temperature === true;
  const ceiling = model.limit?.output;
  const maxOutputTokens = typeof ceiling === 'number' && ceiling > 0 ? { ceiling } : undefined;

  return {
    reasoningEffort,
    temperature,
    topP: temperature,
    maxOutputTokens,
  };
}

/**
 * Drop/clamp every field of a (possibly user- or client-supplied)
 * `GenerationConfig` against what `model` actually supports — the single
 * gate BOTH the routing-policy write path (persistence) and the gateway
 * resolution-layer injection path (see apps/api's routing/resolve-route.ts)
 * must run a value through before it's trusted. A field the model doesn't
 * support is silently dropped (never a validation error) so a model swap
 * doesn't require the caller to also scrub unrelated config.
 */
export function clampGenerationConfig(
  config: GenerationConfig | null | undefined,
  model: CatalogModel | undefined | null,
): GenerationConfig {
  if (!config) return {};
  const caps = generationControlCapabilities(model);
  const out: GenerationConfig = {};

  if (
    typeof config.reasoningEffort === 'string' &&
    caps.reasoningEffort?.values.includes(config.reasoningEffort)
  ) {
    out.reasoningEffort = config.reasoningEffort;
  }
  if (
    typeof config.temperature === 'number' &&
    caps.temperature &&
    Number.isFinite(config.temperature)
  ) {
    out.temperature = Math.min(2, Math.max(0, config.temperature));
  }
  if (typeof config.topP === 'number' && caps.topP && Number.isFinite(config.topP)) {
    out.topP = Math.min(1, Math.max(0, config.topP));
  }
  if (
    typeof config.maxOutputTokens === 'number' &&
    caps.maxOutputTokens &&
    Number.isFinite(config.maxOutputTokens)
  ) {
    out.maxOutputTokens = Math.min(
      caps.maxOutputTokens.ceiling,
      Math.max(1, Math.floor(config.maxOutputTokens)),
    );
  }
  return out;
}

interface CatalogProvider {
  id: string;
  name: string;
  env?: string[];
  doc?: string;
  api?: string | null;
  npm?: string | null;
  models: CatalogModel[];
}

export interface Catalog {
  source: string;
  fetched_at: string;
  provider_count: number;
  model_count: number;
  providers: CatalogProvider[];
}

// The bundled models.dev snapshot (~7.6 MB of JSON) and its one reader live in
// `catalog-data.ts`, never in this module: browser bundles import this entry
// for small helpers, and a bundler can drop `catalog-data.ts` only when this
// file does not import the JSON itself (catalog-isolation.test.ts).
export { CATALOG, catalogModelForWireModel } from './catalog-data';

/**
 * `{ id, env }` for every provider in `CATALOG`, in the same order — the only
 * catalog fields `providerAuthRequirement` reads. ~8 KB instead of the ~7.6 MB
 * snapshot, for browser code that needs provider credentials but no models.
 * Regenerated together with the snapshot; catalog-isolation.test.ts checks
 * that the two agree.
 */
export const CATALOG_PROVIDER_ENV = providerEnvJson as ReadonlyArray<{ id: string; env: string[] }>;

export interface ManagedModel {
  id: string;
  name: string;
  // OpenRouter model ID. OpenRouter is the fallback upstream when
  // `morphModelId` is set, and the only upstream otherwise.
  upstreamModelId: string;
  transport: 'openrouter';
  // Morph model ID. When set, Morph's OpenAI-compatible API is the primary
  // upstream and `pricing` holds Morph's list prices.
  morphModelId?: string;
  // Omit this to keep the model grouped under Kortix in the picker.
  providerBrand?: string;
  // Catalog lookup hint. Managed pricing below is the routing authority.
  pricingRef: string;
  // Explicit upstream per-million-token prices for credit billing.
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
    cachedInputPerMillion?: number;
    cacheWritePerMillion?: number;
    contextOver200k?: {
      inputPerMillion: number;
      outputPerMillion: number;
      cachedInputPerMillion?: number;
      cacheWritePerMillion?: number;
      contextThreshold: number;
    };
  };
  tier: 'flagship' | 'balanced' | 'fast';
  // Image input supported by the upstream model.
  vision: boolean;
  // A conservative OpenCode output ceiling inside the upstream context window.
  limit: { context: number; output: number };
  // OpenRouter provider routing: the allowed endpoint pool and privacy constraints.
  openrouterProvider?: Record<string, unknown>;
}

// A managed model's `pricingRef` is supposed to be the model's real
// models.dev id, but Kortix's own display id is dotted (`claude-opus-4.8`)
// while models.dev Claude ids are dashed (`claude-opus-4-8`) — a mismatch
// here silently misses the models.dev lookup and falls back to a permissive
// synthetic capability record (no reasoning_options, temperature always
// true), which is wrong for real models. Consumers doing a `provider/model`
// lookup by `pricingRef` should try these candidates in order rather than
// a single exact match, so a dotted/dashed slip degrades gracefully instead
// of silently losing real capability data.
export function pricingRefLookupCandidates(pricingRef: string): string[] {
  const slash = pricingRef.indexOf('/');
  if (slash <= 0) return [pricingRef];
  const providerId = pricingRef.slice(0, slash);
  const modelId = pricingRef.slice(slash + 1);
  const candidates = [pricingRef];
  const dashed = `${providerId}/${modelId.replace(/\./g, '-')}`;
  if (dashed !== pricingRef) candidates.push(dashed);
  return candidates;
}

// Managed IDs are bare gateway model IDs. OpenCode uses `kortix/<id>`, so the
// picker shows Kortix whichever upstream serves the request.
//
// Morph direct is the primary upstream. When a Morph dispatch fails (HTTP error
// or network error before output), the gateway sends the same request to the
// OpenRouter pool. Each pool lists only endpoints that, on 2026-09-24, were in
// OpenRouter's ZDR feed, had a CONFIRMED US datacenter (US headquarters plus US
// datacenters in /api/v1/providers, or a `/us` endpoint tag), and answered pinned
// text and image probes. US headquarters alone does not qualify. `allow_fallbacks: true` lets OpenRouter move between pool members;
// `only` keeps it inside the pool. `max_price` (USD per 1M tokens) excludes premium
// tiers. packages/llm-catalog/README.md records the probe results.
// Vision is explicit per model so the picker and runtime reject image input for text-only models.
const OPENROUTER_POOL_PRIVACY = { allow_fallbacks: true, zdr: true, data_collection: 'deny' } as const;

export const MANAGED_MODELS: ManagedModel[] = [
  {
    id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', upstreamModelId: 'deepseek/deepseek-v4.1-flash',
    transport: 'openrouter', morphModelId: 'morph-dsv41flash', pricingRef: 'openrouter/deepseek/deepseek-v4.1-flash',
    // Morph publishes no DeepSeek V4.1 Flash cached rate; this is its DeepSeek V4 Flash rate.
    pricing: { inputPerMillion: 0.15, cachedInputPerMillion: 0.0359375, outputPerMillion: 0.6 },
    tier: 'balanced', vision: true, limit: { context: 1_048_576, output: 16_384 },
    openrouterProvider: {
      only: ['morph', 'coreweave/fp8'],
      ...OPENROUTER_POOL_PRIVACY,
      max_price: { prompt: 0.3, completion: 1.2 },
    },
  },
  {
    id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', upstreamModelId: 'z-ai/glm-5.3-flash',
    transport: 'openrouter', morphModelId: 'morph-glm53flash', pricingRef: 'openrouter/z-ai/glm-5.3-flash',
    pricing: { inputPerMillion: 0.1, cachedInputPerMillion: 0.02, outputPerMillion: 0.35 },
    tier: 'fast', vision: true, limit: { context: 1_048_576, output: 16_384 },
    openrouterProvider: {
      only: ['morph', 'decart/fp4', 'coreweave/nvfp4', 'sail-research/us'],
      ...OPENROUTER_POOL_PRIVACY,
      max_price: { prompt: 0.15, completion: 0.5 },
    },
  },
  {
    id: 'kimi-k3', name: 'Kimi K3 2.8T', upstreamModelId: 'moonshotai/kimi-k3',
    transport: 'openrouter', morphModelId: 'morph-kimik3', pricingRef: 'openrouter/moonshotai/kimi-k3',
    pricing: { inputPerMillion: 2.5, cachedInputPerMillion: 0.29, outputPerMillion: 14 },
    tier: 'flagship', vision: true, limit: { context: 1_048_576, output: 16_384 },
    openrouterProvider: {
      only: ['morph', 'fireworks/us'],
      ...OPENROUTER_POOL_PRIVACY,
      max_price: { prompt: 3.3, completion: 16.5 },
    },
  },
];

const MANAGED_BY_ID = new Map(MANAGED_MODELS.map((m) => [m.id, m] as const));

export function getManagedModel(id: string): ManagedModel | undefined {
  return MANAGED_BY_ID.get(id);
}

export function isManagedModelId(id: string): boolean {
  return MANAGED_BY_ID.has(id);
}

export const DEFAULT_MANAGED_MODEL_IDS = MANAGED_MODELS.map((m) => m.id);

export const MANAGED_FLAGSHIP_MODEL_ID = (
  MANAGED_MODELS.find((m) => m.tier === 'flagship') ?? MANAGED_MODELS[0]
).id;

/** Concrete Kortix-managed default used when no account or project default exists. */
export const PLATFORM_DEFAULT_MODEL_ID = 'deepseek-v4.1-flash';

export const MODEL_SELECTOR_PROVIDER_IDS = [
  'kortix',
  'opencode',
  'anthropic',
  'openai',
  'github-copilot',
  'google',
  'openrouter',
  'vercel',
] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'ChatGPT subscription',
  google: 'Google',
  xai: 'xAI',
  moonshotai: 'Moonshot',
  'moonshotai-cn': 'Moonshot',
  opencode: 'OpenCode Zen',
  kortix: 'Kortix',
  firmware: 'Firmware',
  // models.dev's canonical provider id is `amazon-bedrock` (see
  // `PROVIDER_AUTH_REQUIREMENT_OVERRIDES` above and `catalog.generated.json`),
  // and that is the id the gateway stamps onto `GatewayModel.provider`. The
  // short `bedrock` alias is kept for legacy call sites, mirroring the icon
  // map in apps/web's provider-branding. Missing the canonical key here is
  // what made the picker label the whole Bedrock group "Kortix": the label
  // lookup fell through to `FlatModel.providerName`, which is always "Kortix"
  // under the gateway.
  'amazon-bedrock': 'Amazon Bedrock',
  bedrock: 'Amazon Bedrock',
  openrouter: 'OpenRouter',
  'github-copilot': 'GitHub Copilot',
  vercel: 'Vercel',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  cohere: 'Cohere',
  llama: 'Llama',
  huggingface: 'Hugging Face',
  cerebras: 'Cerebras',
  togetherai: 'Together AI',
  fireworks: 'Fireworks',
  deepinfra: 'DeepInfra',
  nvidia: 'NVIDIA',
  cloudflare: 'Cloudflare',
  azure: 'Azure',
  ollama: 'Ollama',
  perplexity: 'Perplexity',
  lmstudio: 'LM Studio',
  v0: 'v0',
  wandb: 'W&B',
  baseten: 'Baseten',
  // MiniMax is its own distinct BYOK provider (minimax.io / minimaxi.com) —
  // not Moonshot. Was mislabeled 'Moonshot' for both regional variants.
  minimax: 'MiniMax',
  'minimax-cn': 'MiniMax',
  siliconflow: 'SiliconFlow',
  'siliconflow-cn': 'SiliconFlow',
  zhipuai: 'ZhipuAI',
  'zhipuai-cn': 'ZhipuAI',
  'google-vertex': 'Google Vertex',
  'google-vertex-anthropic': 'Vertex Anthropic',
  'azure-cognitive-services': 'Azure Cognitive',
  'cloudflare-ai-gateway': 'Cloudflare Gateway',
  'github-models': 'GitHub Models',
  'ollama-cloud': 'Ollama Cloud',
  'kai Coding Plan': 'AI21',
  zaicodingplan: 'AI21',
  venice: 'Venice',
  upstage: 'Upstage',
  nebius: 'Nebius',
  vultr: 'Vultr',
  friendli: 'Friendli',
  poe: 'Poe',
  requesty: 'Requesty',
  'sap-ai-core': 'SAP AI Core',
  scaleway: 'Scaleway',
  inception: 'Inception',
  morph: 'Morph',
  abacus: 'Abacus',
  bailing: 'Bailing',
  chutes: 'Chutes',
  fastrouter: 'FastRouter',
  helicone: 'Helicone',
  iflowcn: 'iFlytek',
  inference: 'Inference',
  'io-net': 'IO.net',
  'kimi-for-coding': 'Kimi',
  lucidquery: 'LucidQuery',
  modelscope: 'ModelScope',
  'nano-gpt': 'NanoGPT',
  ovhcloud: 'OVHcloud',
  submodel: 'Submodel',
  synthetic: 'Synthetic',
  xiaomi: 'Xiaomi',
  zenmux: 'Zenmux',
};
