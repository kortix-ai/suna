import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateOAuthAccessToken, oauthScopeAllowsPath } from '../../services/oauth/access-token';
import { auditLoginFail, auditLoginSuccess } from '../../services/audit/auth-audit';
import { setSentryUser } from '../../lib/sentry';
import { setContextField } from '../../lib/request-context';

/**
 * Sign in with Kortix: resolve a `kortix_oat_` OAuth access token to the user
 * who granted it. Shared by supabaseAuth and combinedAuth so both middlewares
 * hand a route the same principal (see unit-oauth-access-token-auth.test.ts).
 * Throws on any failure; sets the context and returns on success.
 */
export async function applyOAuthAccessTokenPrincipal(c: Context, token: string): Promise<void> {
  const result = await validateOAuthAccessToken(token);
  if (!result.isValid || !result.userId) {
    auditLoginFail({ c, reason: result.error ?? 'invalid_oauth_token', authType: 'oauth' });
    throw new HTTPException(401, { message: result.error || 'Invalid OAuth access token' });
  }
  const scopes = result.scopes ?? [];
  if (!oauthScopeAllowsPath(scopes, c.req.path)) {
    auditLoginFail({ c, reason: 'insufficient_scope', authType: 'oauth', accountId: result.accountId ?? null });
    throw new HTTPException(403, {
      message: `insufficient_scope: this OAuth token was not granted the "kortix" scope, so it cannot reach ${c.req.path}`,
    });
  }
  c.set('userId', result.userId);
  c.set('userEmail', '');
  c.set('authType', 'oauth');
  if (result.accountId) c.set('accountId', result.accountId);
  c.set('oauthClientId', result.clientId);
  c.set('oauthScopes', scopes);
  // No iamTokenId: the token acts AS the user (role-only), like an unscoped PAT.
  c.set('agentGrant', null);
  setSentryUser({ id: result.userId, accountId: result.accountId });
  setContextField('userId', result.userId);
  if (result.accountId) setContextField('accountId', result.accountId);
  auditLoginSuccess({
    c,
    userId: result.userId,
    accountId: result.accountId ?? null,
    authType: 'oauth',
    metadata: { oauth_client_id: result.clientId, scopes },
  });
}
