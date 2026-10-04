import type { AgentGrant } from '@kortix/db';

// Context variables set by auth middleware (platform).
// Single source of truth for everything apiKeyAuth / supabaseAuth / combinedAuth
// write onto the Hono context — keep this in sync with http/middleware/auth.ts.
export interface AuthVariables {
  userId: string;
  userEmail: string;
  accountId?: string;
  authType?: 'supabase' | 'pat' | 'apiKey' | 'service_account' | 'oauth';
  apiKeyType?: 'user' | 'sandbox';
  /** Sign in with Kortix: the OAuth client the `kortix_oat_` token was minted for. */
  oauthClientId?: string;
  /** Sign in with Kortix: scopes granted to the token (`profile`, `email`, `kortix`). */
  oauthScopes?: string[];
  keyId?: string;
  sandboxId?: string;
  /** Set for project-scoped CLI PATs — enforced against the URL :projectId. */
  tokenProjectId?: string;
  /** Set for session-scoped sandbox connector PATs. */
  sessionId?: string;
  /** PAT token identity for the IAM engine (token-as-principal evaluation). */
  iamTokenId?: string;
  /** Per-agent authorization grant — non-null only for agent-session tokens.
   *  Read by assertAgentScope() to gate Kortix CLI/API actions on top of the
   *  user's own role (net = userRole ∩ agentGrant). Null = full access. */
  agentGrant?: AgentGrant | null;
  /** The human an agent-session token acts on behalf of. Null for an
   *  unattended run, a cleared session, or any non-session credential. */
  onBehalfOfUserId?: string | null;
  /** Live impersonation grant id — set only while a platform admin acts as an
   *  account (http/middleware/impersonation.ts). Its presence means `accountId` is
   *  the TARGET account, not the caller's own. */
  impersonationGrantId?: string;
  /** The REAL platform admin behind an impersonated request. `userId` stays the
   *  same id; this exists so audit rows can carry both identities explicitly. */
  impersonatorUserId?: string;
  /** Platform role, set by requireAdmin on /v1/admin routes. */
  platformRole?: string;
}

// Hono environment type — Variables match exactly what the auth middleware sets.
export type AppEnv = {
  Variables: AuthVariables;
};
