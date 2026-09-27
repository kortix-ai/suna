import type { BillingMode } from './principal';

export type ProviderKind =
  | 'openai-compat'
  | 'openai-responses'
  | 'anthropic'
  | 'bedrock'
  | 'custom';

export interface UpstreamPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  // Prompt-cache WRITE rate (Anthropic's cache-creation premium — ~1.25x base
  // input for the default 5-minute TTL, ~2x for a 1-hour TTL). Falls back to a
  // documented multiple of inputPerMillion when a live source doesn't provide
  // it (see usage/pricing.ts).
  cacheWritePerMillion?: number;
  tiers?: UpstreamPricingTier[];
  contextOver200k?: UpstreamPricingTier;
}

export interface UpstreamPricingTier extends UpstreamPricing {
  contextThreshold: number;
}

export interface UpstreamDescriptor {
  provider: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  /** Stable non-secret identifier for credentials that share one provider. */
  credentialRef?: string;
  /**
   * Set only for an account-secret pool member: an explicitly selected session
   * pool, or the project-shared accounts a session without a pool falls back to.
   * A 429 records the key's cooldown and moves the request to the next member.
   */
  poolSecretId?: string;
  /**
   * Provider failover. When the first candidate sets this, a failed dispatch
   * (thrown error or non-2xx before any output) moves the same request to the
   * next candidate that also sets it, in order. Kortix-managed models set it on
   * the primary provider and its fallbacks. BYOK never sets it: a failed BYOK
   * key must fail as BYOK.
   */
  failover?: boolean;
  /**
   * The provider name clients see instead of `provider`. When set, every
   * client-visible surface — response bodies, SSE events, headers, error
   * bodies, usage events, and request traces — names this provider and the
   * routed model, never the upstream or its model id. Kortix-managed models
   * set it to `kortix`.
   */
  publicProvider?: string;
  billingMode: BillingMode;
  markup: number;
  appName?: string;
  appReferer?: string;
  resolvedModel?: string;
  headers?: Record<string, string>;
  omitAuthorization?: boolean;
  pricing?: UpstreamPricing;
  // Model capability flags mirrored from the catalog (models.dev enrichment,
  // see apps/api/src/llm-gateway/models/catalog-models.ts capabilitiesOf).
  // Transports use these to decide whether to translate/strip params the
  // target model actually rejects, instead of hardcoding a model-id list.
  // `reasoning` = the model is a reasoning/o-series-style model.
  // `temperature` = the model accepts a non-default temperature/top_p/etc.
  // Left undefined for upstreams that don't carry catalog capability data
  // (managed models, custom/self-hosted) — treated as "unknown, don't guess".
  reasoning?: boolean;
  temperature?: boolean;
  // Upstream-specific fields merged into the outgoing request body, overriding
  // any same-named client fields (e.g. OpenRouter's `provider` routing
  // preferences pinning managed models to reliable hosts). openai-compat only.
  bodyExtras?: Record<string, unknown>;
  // The models.dev `npm` field for the provider (e.g. '@ai-sdk/openai',
  // '@ai-sdk/anthropic', '@ai-sdk/amazon-bedrock'). Selects the AI SDK provider
  // package under the 'ai-sdk' transport engine. Optional: when absent the engine
  // falls back to `kind`. Ignored by the native transports.
  npm?: string;
  // AWS region for the Bedrock provider under the 'ai-sdk' engine (bearer-token
  // auth still comes from `apiKey`; region only selects the endpoint host).
  // Ignored by every other provider/engine.
  region?: string;
}
