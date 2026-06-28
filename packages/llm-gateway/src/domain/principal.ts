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
}

export type BillingMode = 'credits' | 'platform-fee' | 'none';
