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

export interface BedrockConfig {
  enabled: boolean;
  region: string;
  /** Optional static creds. When omitted, the AWS default credential chain
   * (env vars, EKS IRSA / instance role) is used. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export interface LlmGatewayConfig {
  enabled: boolean;
  openrouterApiKey: string;
  baseUrl?: string;
  markup?: number;
  appName?: string;
  appReferer?: string;
  /** AWS Bedrock backend. When enabled, models prefixed `bedrock/` are routed
   * to Bedrock instead of OpenRouter. */
  bedrock?: BedrockConfig;
}
