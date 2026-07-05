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
  // Upstream-specific fields merged into the outgoing request body, overriding
  // any same-named client fields (e.g. OpenRouter's `provider` routing
  // preferences pinning managed models to reliable hosts). openai-compat only.
  bodyExtras?: Record<string, unknown>;
}
