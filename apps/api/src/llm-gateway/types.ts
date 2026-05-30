export interface AuthedPrincipal {
  userId: string;
  accountId: string;
}

export interface UsageEvent {
  accountId: string;
  actorUserId: string;
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
