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
}
