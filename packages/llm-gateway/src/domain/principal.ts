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
  // The account/project/agent-configured default model, resolved once at
  // authentication (see apps/api llm-gateway/resolution/default-model). `auto`
  // resolves to this; undefined → the platform target. Travels with the
  // principal so it survives the RPC hop to the standalone gateway pod.
  defaultModel?: string;
}

export type BillingMode = 'credits' | 'platform-fee' | 'none';
