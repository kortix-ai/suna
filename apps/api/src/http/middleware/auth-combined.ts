import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateSecretKey } from '../../services/repositories/api-keys';
import { validateAccountToken } from '../../services/repositories/account-tokens';
import { validateServiceAccountToken } from '../../services/repositories/service-accounts';
import { isKortixToken, isAccountToken, isServiceAccountToken } from '../../lib/crypto';
import { canAccessPreviewSandbox } from '../../services/sessions/preview-ownership';
import { getSupabase } from '../../lib/supabase';
import { decodeSupabaseJwtPayload, verifySupabaseJwt } from '../../services/auth/jwt-verify';
// From its own module, not '../../services/auth/jwt-verify': five test files replace that
// module wholesale, and a mock cannot be allowed to change how a real failure is
// classified.
import { isInconclusiveVerifyFailure } from '../../services/auth/jwt-verify-outcome';
import { setSentryUser } from '../../lib/sentry';
import { setContextField } from '../../lib/request-context';
import { auditLoginFail, auditLoginSuccess } from './auth-audit';
import { requestClientKey } from '../lib/client-ip';
import { isOAuthAccessToken, oauthScopeAllowsPath, validateOAuthAccessToken } from '../../services/oauth/access-token';
import { applyImpersonation } from './impersonation';
import { withActor } from './auth-actor';
import { beginStage } from '../../lib/server-timing';
import { presentedKortixToken, withTokenAttemptBudget } from './token-attempt-budget';

import { serviceAccountPrincipal, patPrincipal, jwtPrincipal } from './auth-principal';
import { applyOAuthAccessTokenPrincipal } from './auth-oauth';
import { deadCredential401 } from './auth';
import { enforceTokenProjectScope, extractPreviewSandboxId, setPreviewSessionCookie } from './auth-scope';

const PREVIEW_SESSION_COOKIE = '__preview_session';


/**
 * Combined auth — accepts Kortix tokens OR Supabase JWTs.
 *
 * Token resolution order:
 *   1. Authorization: Bearer <token> header
 *   2. __preview_session cookie (set via POST /v1/p/auth)
 *
 * Used for:
 *   - Preview proxy routes (/v1/p/{sandboxId}/{port}/*)
 *   - Cron, secrets, providers, servers, and tunnel routes
 *   - SSE stream endpoints (clients use fetch() with Authorization header)
 *
 * Sets userId and userEmail in context regardless of token type.
 * For preview proxy routes, also sets/refreshes the session cookie.
 */
export async function combinedAuth(c: Context, next: Next) {
  const endAuth = beginStage('auth');
  try {
    return await withTokenAttemptBudget(c, presentedKortixToken(c, PREVIEW_SESSION_COOKIE), () =>
      resolveCombinedAuth(c, () =>
        applyImpersonation(c, () => withActor(c, () => (endAuth(), next()))),
      ),
    );
  } finally {
    endAuth();
  }
}

async function resolveCombinedAuth(c: Context, next: Next) {
  // Skip auth for CORS preflight — OPTIONS never carries auth tokens.
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const previewSandboxId = extractPreviewSandboxId(c.req.path);
  const token = extractToken(c, previewSandboxId);
  if (!token) {
    auditLoginFail({ c, reason: 'missing_token' });
    throw new HTTPException(401, { message: 'Missing authentication token' });
  }
  const isPreviewRoute = c.req.path.startsWith('/v1/p/') || c.req.path === '/v1/p';
  if (isServiceAccountToken(token)) return resolveServiceAccount(c, next, token, previewSandboxId, isPreviewRoute);
  if (isAccountToken(token)) return resolvePat(c, next, token, isPreviewRoute);
  if (isOAuthAccessToken(token)) {
    await applyOAuthAccessTokenPrincipal(c, token);
    if (isPreviewRoute) setPreviewSessionCookie(c, token);
    return next();
  }
  if (isKortixToken(token)) return resolveKortixToken(c, next, token, previewSandboxId, isPreviewRoute);
  return resolveJwt(c, next, token, previewSandboxId, isPreviewRoute);
}

function extractToken(c: Context, previewSandboxId: string | null) {
  // Extract token: header → X-Kortix-Token (preview only) → cookie → query param
  const authHeader = c.req.header('Authorization');
  const kortixTokenHeader = previewSandboxId ? c.req.header('X-Kortix-Token') : undefined;
  let token: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  if (!token && kortixTokenHeader && isKortixToken(kortixTokenHeader)) {
    token = kortixTokenHeader;
  }

  if (!token) {
    // Check for session cookie (set via POST /v1/p/auth or by prior requests)
    const cookieHeader = c.req.header('Cookie') || '';
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${PREVIEW_SESSION_COOKIE}=([^;]+)`));
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }

  if (!token) {
    // Last resort: query tokens are allowed only for legacy EventSource
    // provision-stream. Browser WebSocket preview auth is handled by the Bun
    // upgrade path (ws-proxy.ts), not this HTTP middleware. Do not accept
    // ?token= on ordinary preview HTTP routes: it leaks bearer material into
    // URLs, logs, history, and Referer headers.
    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get('token');
    if (queryToken && c.req.path.includes('/provision-stream')) {
      token = queryToken;
    }
  }

  return token;
}

async function resolveServiceAccount(c: Context, next: Next, token: string, previewSandboxId: string | null, isPreviewRoute: boolean) {
  // 0. Service-account bearer (non-human IAM principal) — mirrors the
  // supabaseAuth branch. MUST run before the generic Kortix-token branch:
  // `kortix_sa_` also matches the `kortix_` prefix, so without this check the
  // token falls into validateSecretKey and every combinedAuth-mounted route
  // (preview proxy, cron, secrets, providers, SSE) rejects service accounts
  // that supabaseAuth-mounted routes accept.
  {
    const sa = await validateServiceAccountToken(token);
    if (!sa.isValid || !sa.serviceAccountId || !sa.accountId) {
      auditLoginFail({
        c,
        reason: sa.error ?? 'invalid_service_account',
        authType: 'service_account',
      });
      throw new HTTPException(401, { message: sa.error || 'Invalid service account' });
    }
    if (
      previewSandboxId &&
      !(await canAccessPreviewSandbox({ previewSandboxId, accountId: sa.accountId }))
    ) {
      auditLoginFail({
        c,
        reason: 'preview_sandbox_not_authorized',
        authType: 'service_account',
        accountId: sa.accountId,
      });
      throw new HTTPException(403, { message: 'Not authorized to access this sandbox' });
    }
    serviceAccountPrincipal(c, sa.serviceAccountId, sa.accountId, { token, enabled: isPreviewRoute });
    await next();
    return;
  }

}

async function resolvePat(c: Context, next: Next, token: string, isPreviewRoute: boolean) {
  // 1. CLI Personal Access Token — carries a real user_id.
  {
    const patResult = await validateAccountToken(token);
    if (!patResult.isValid || !patResult.userId) {
      auditLoginFail({ c, reason: patResult.error ?? 'invalid_pat', authType: 'pat' });
      // Same typed 401 as supabaseAuth's resolvePat: a credential that can
      // never come back is marked with code 'session_token_revoked' so the
      // caller's retry loop can stop.
      if (patResult.credentialDead) {
        throw deadCredential401(patResult.error || 'Credential is no longer valid');
      }
      throw new HTTPException(401, { message: patResult.error || 'Invalid PAT' });
    }
    if (patResult.projectId) {
      await enforceTokenProjectScope(c, patResult.projectId, {
        sessionBound: Boolean(patResult.sessionId),
      });
    }
    patPrincipal(c, patResult, { token, enabled: isPreviewRoute });
    await next();
    return;
  }

}

async function resolveKortixToken(c: Context, next: Next, token: string, previewSandboxId: string | null, isPreviewRoute: boolean) {
  // 2. Try Kortix token (kortix_ or kortix_sb_) — used by agents inside the sandbox
  {
    const result = await validateSecretKey(token);
    if (!result.isValid) {
      auditLoginFail({
        c,
        reason: result.error ?? 'invalid_kortix_token',
        authType: 'apiKey',
      });
      throw new HTTPException(401, { message: result.error || 'Invalid Kortix token' });
    }
    if (
      previewSandboxId &&
      !(await canAccessPreviewSandbox({
        previewSandboxId,
        accountId: result.accountId,
      }))
    ) {
      auditLoginFail({
        c,
        reason: 'preview_sandbox_not_authorized',
        authType: 'apiKey',
        accountId: result.accountId ?? null,
      });
      throw new HTTPException(403, { message: 'Not authorized to access this sandbox' });
    }
    // Map accountId → userId so route handlers work unchanged
    c.set('userId', result.accountId);
    c.set('userEmail', '');
    c.set('authType', 'apiKey');
    c.set('apiKeyType', result.type);
    if (result.accountId) c.set('accountId', result.accountId);
    if (result.keyId) c.set('keyId', result.keyId);
    if (result.sandboxId) c.set('sandboxId', result.sandboxId);
    setSentryUser({ id: result.accountId || 'unknown', accountId: result.accountId });
    setContextField('accountId', result.accountId || 'unknown');
    if (isPreviewRoute) setPreviewSessionCookie(c, token);
    auditLoginSuccess({
      c,
      userId: result.accountId ?? 'unknown',
      accountId: result.accountId ?? null,
      authType: 'apiKey',
      metadata: { api_key_type: result.type },
    });
    await next();
    return;
  }

}

async function resolveJwt(c: Context, next: Next, token: string, previewSandboxId: string | null, isPreviewRoute: boolean) {
  // 3. Try Supabase JWT — fast path: local verification (no network roundtrip)
  const local = await verifySupabaseJwt(token);
  if (local.ok) {
    if (
      previewSandboxId &&
      !(await canAccessPreviewSandbox({
        previewSandboxId,
        userId: local.userId,
      }))
    ) {
      auditLoginFail({
        c,
        reason: 'preview_sandbox_not_authorized',
        authType: 'jwt',
        userId: local.userId,
      });
      throw new HTTPException(403, { message: 'Not authorized to access this sandbox' });
    }
    await jwtPrincipal(c, local.userId, local.email, local.payload as Record<string, unknown>, 'local', { token, enabled: isPreviewRoute });
    await next();
    return;
  }

  // Token is definitively bad (bad sig, expired, malformed) — reject immediately.
  // An inconclusive result falls through to the network path below instead.
  if (!isInconclusiveVerifyFailure(local.reason)) {
    auditLoginFail({ c, reason: `jwt_${local.reason}`, authType: 'jwt' });
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  // JWKS not yet loaded — fall back to network getUser() call
  try {
    const supabase = getSupabase();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      auditLoginFail({
        c,
        reason: error?.message ?? 'jwt_network_invalid',
        authType: 'jwt',
      });
      throw new HTTPException(401, { message: 'Invalid or expired token' });
    }

    if (
      previewSandboxId &&
      !(await canAccessPreviewSandbox({
        previewSandboxId,
        userId: user.id,
      }))
    ) {
      auditLoginFail({
        c,
        reason: 'preview_sandbox_not_authorized',
        authType: 'jwt',
        userId: user.id,
      });
      throw new HTTPException(403, { message: 'Not authorized to access this sandbox' });
    }

    const payload = decodeSupabaseJwtPayload(token);
    await jwtPrincipal(c, user.id, user.email || '', (payload as Record<string, unknown> | null) ?? (user as unknown as Record<string, unknown>), 'network', { token, enabled: isPreviewRoute }, user.email || undefined);
    await next();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    console.error('[AUTH] Error:', err);
    auditLoginFail({ c, reason: 'auth_internal_error', authType: 'jwt' });
    throw new HTTPException(401, { message: 'Authentication failed' });
  }
}
