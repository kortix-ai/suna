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
}

export interface UpstreamDescriptor {
  provider: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
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
}
