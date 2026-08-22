import type { BillingMode } from './principal';

export interface TokenCounts {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  // Prompt-cache WRITE tokens (Anthropic's `cache_creation_input_tokens`) —
  // billed at a premium over plain input (see usage/pricing.ts), never at the
  // cache-read discount. Already included in `promptTokens` (kept there for
  // total_tokens back-compat); this field exists so the premium can be priced
  // and reported separately. Zero on providers with no cache-write concept.
  cacheWriteTokens: number;
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
  // Present when the pre-dispatch billing gate took an atomic admission hold
  // against the wallet for this request (see AuthedPrincipal.billingHold).
  // The host's recordUsage hook reconciles this against `finalCost` (top up
  // the remainder, or refund the unused portion) instead of a flat deduct.
  billingHoldUsd?: number;
}
