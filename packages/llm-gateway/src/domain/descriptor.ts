import type { BillingMode } from './principal';

export type ProviderKind = 'openai-compat' | 'openai-responses' | 'anthropic' | 'custom';

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
}
