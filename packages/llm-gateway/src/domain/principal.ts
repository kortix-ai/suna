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
}

export type BillingMode = 'credits' | 'platform-fee' | 'none';
