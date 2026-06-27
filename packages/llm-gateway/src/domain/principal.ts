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
  // True when the account may ONLY use free managed models (free tier with
  // internal billing on). Drives both the served-catalog filter and the `auto`
  // router so a free user only ever sees and routes to free models.
  freeModelsOnly?: boolean;
}

export type BillingMode = 'credits' | 'platform-fee' | 'none';
