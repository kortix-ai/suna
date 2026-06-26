import type { BillingMode } from './principal';

export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface UsageEvent extends TokenCounts {
  accountId: string;
  actorUserId: string;
  // Per-session attribution carried onto the usage event so usage_events rows
  // (not only the trace) are attributable to the calling project/session.
  projectId?: string;
  sessionId?: string;
  provider: string;
  model: string;
  upstreamCost: number;
  finalCost: number;
  billingMode: BillingMode;
  streaming: boolean;
  requestId: string;
}
