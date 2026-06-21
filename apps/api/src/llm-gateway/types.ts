interface AuthedPrincipal {
  userId: string;
  accountId: string;
  /** Project + session the calling token is scoped to (sandbox executor token),
   *  so usage is attributed per-session — the reaper's reliable activity signal
   *  and precise billing attribution. Null for legacy/non-session tokens. */
  projectId?: string | null;
  sessionId?: string | null;
}

export interface UsageEvent {
  accountId: string;
  actorUserId: string;
  projectId?: string | null;
  sessionId?: string | null;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  upstreamCost: number;
  finalCost: number;
  streaming: boolean;
  requestId: string;
}

export interface LlmGatewayHooks {
  authenticateToken: (plaintext: string) => Promise<AuthedPrincipal | null>;
  assertBillingActive: (accountId: string) => Promise<void>;
  recordUsage: (event: UsageEvent) => Promise<void>;
}

export interface LlmGatewayConfig {
  enabled: boolean;
  openrouterApiKey: string;
  baseUrl?: string;
  markup?: number;
  appName?: string;
  appReferer?: string;
}
