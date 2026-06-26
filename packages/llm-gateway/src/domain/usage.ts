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
  // Set when a billable turn priced to $0 (no pricing for the resolved model).
  // Carried onto the usage_events row so unpriced revenue leaks are queryable for
  // backfill rather than silently completing as a $0 debit.
  unpriced?: boolean;
}
