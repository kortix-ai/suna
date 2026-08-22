export interface AuthedPrincipal {
  userId: string;
  accountId: string;
  projectId?: string;
  sessionId?: string;
  keyId?: string;
  // Resolved billing tier (e.g. 'free', 'pro', 'per_seat'). Attached once at
  // authentication so it travels with the principal — including across the RPC
  // boundary to the out-of-process gateway pod — without a second tier lookup.
  tier?: string;
  // True when the account may not use platform-managed Kortix models (free tier
  // with internal billing on). The served catalog still includes BYOK/Codex
  // project models so users can connect their own provider.
  freeModelsOnly?: boolean;
  // The account/agent-configured default model this principal's session should use
  // when it asks for the synthetic `auto` model — a concrete gateway wire model
  // (e.g. 'glm-5.2', 'anthropic/claude-sonnet-4.6'), never `auto`. Resolved once at
  // authentication (agent default → account default) and undefined when there is no
  // configured default (→ the platform default applies). Travels with the principal
  // across the RPC boundary so the standalone pod resolves `auto` identically.
  defaultModel?: string;
  // Set only when the pre-dispatch billing gate took an ATOMIC admission hold
  // against the account's wallet (the pure-credits path — see billing-gate.ts
  // checkBillingActive) rather than a stale read-only balance check. Carries
  // the reserved dollar amount so settle() can reconcile it to the real cost
  // (top up the remainder or refund the unused portion) instead of a flat
  // post-hoc deduct — closing the check-then-act race where concurrent
  // requests could all be admitted against the same unspent balance.
  billingHold?: { amountUsd: number };
}

export type BillingMode = 'credits' | 'platform-fee' | 'none';
