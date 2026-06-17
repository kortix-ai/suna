import type { BillingMode } from './principal';

export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface UsageEvent extends TokenCounts {
  accountId: string;
  actorUserId: string;
  provider: string;
  model: string;
  upstreamCost: number;
  finalCost: number;
  billingMode: BillingMode;
  streaming: boolean;
  requestId: string;
}
