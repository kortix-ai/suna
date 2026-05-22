import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateSecretKey } from '../repositories/api-keys';
import { validateAccountToken } from '../repositories/account-tokens';
import { validateServiceAccountToken } from '../repositories/service-accounts';
import { isKortixToken, isAccountToken, isServiceAccountToken } from '../shared/crypto';
import { canAccessPreviewSandbox } from '../shared/preview-ownership';
import { getSupabase } from '../shared/supabase';
import { verifySupabaseJwt } from '../shared/jwt-verify';
import { setSentryUser } from '../lib/sentry';
import { setContextField } from '../lib/request-context';
import { syncSsoMembership } from '../iam/sso-sync';

const PREVIEW_SESSION_COOKIE = '__preview_session';

// ═══════════════════════════════════════════════════════════════════════════════
// Auth Middleware (3 middlewares — one per auth strategy)
//
//   1. apiKeyAuth      — Kortix API keys only (header)
//   2. supabaseAuth    — Supabase JWT only (header)
//   3. combinedAuth    — Kortix OR Supabase (header + cookie fallback)
//
// Token is read from query parameters ONLY as a last resort for preview proxy
// routes (/v1/p/*) — browser WebSocket API can't set custom headers, so PTY
// terminals pass the token as ?token=<jwt>. SSE clients use fetch() with
// Authorization headers; preview iframes use cookies set via POST /v1/p/auth.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * API key auth for search, LLM, and router routes.
 * Always validates Kortix tokens (kortix_, kortix_sb_) via validateSecretKey()
 * against the api_keys table.
 */
export async function apiKeyAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, {
      message: 'Missing or invalid Authorization header',
    });
  }

  const token = authHeader.slice(7);

  if (!token) {
    throw new HTTPException(401, {
      message: 'Missing token in Authorization header',
    });
  }

  if (!isKortixToken(token)) {
    throw new HTTPException(401, {
      message: 'Invalid token format — expected kortix_ prefix',
    });
  }

  const result = await validateSecretKey(token);

  if (!result.isValid) {
    console.warn(`[apiKeyAuth] Token validation failed: ${result.error} | tokenPrefix="${token.slice(0, 20)}..." | path=${c.req.path} | ip=${c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown'}`);
    throw new HTTPException(401, {
      message: result.error || 'Invalid API key',
    });
  }

  c.set('accountId', result.accountId);
  c.set('keyId', result.keyId);
  c.set('authType', 'apiKey');
  c.set('apiKeyType', result.type);
  if (result.sandboxId) {
    c.set('sandboxId', result.sandboxId);
  }
  await next();
}

/**
 * Supabase JWT auth (for billing, platform, admin routes).
 * Header-only — sets userId and userEmail in context on success.
 *
 * Also accepts CLI Personal Access Tokens (kortix_pat_...) — these carry
 * a real user_id from the account_tokens table, so the rest of the
 * pipeline (resolveAccountId, project access checks, etc.) works
 * unchanged.
 */
export async function supabaseAuth(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    throw new HTTPException(401, { message: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  if (!token) {
    throw new HTTPException(401, { message: 'Missing token' });
  }

  // Service-account bearer (non-human IAM principal). Treat as a
  // token-style principal: userId is set to the SA id (synthetic) so
  // downstream code has a stable identifier, and iamTokenId points
  // at the same id so the IAM engine evaluates only the SA's policies
  // (existing token-as-principal short-circuit).
  if (isServiceAccountToken(token)) {
    const sa = await validateServiceAccountToken(token);
    if (!sa.isValid || !sa.serviceAccountId || !sa.accountId) {
      throw new HTTPException(401, { message: sa.error || 'Invalid service account' });
    }
    c.set('userId', sa.serviceAccountId);
    c.set('userEmail', '');
    c.set('authType', 'service_account');
    c.set('accountId', sa.accountId);
    c.set('iamTokenId', sa.serviceAccountId);
    setSentryUser({ id: sa.serviceAccountId, accountId: sa.accountId });
    setContextField('userId', sa.serviceAccountId);
    setContextField('accountId', sa.accountId);
    await next();
    return;
  }

  // CLI Personal Access Token — same identity as the user who minted it.
  if (isAccountToken(token)) {
    const result = await validateAccountToken(token);
    if (!result.isValid || !result.userId) {
      throw new HTTPException(401, { message: result.error || 'Invalid PAT' });
    }
    // Project-scoped tokens: enforce the URL's :projectId matches.
    if (result.projectId) {
      enforceTokenProjectScope(c, result.projectId);
    }
    c.set('userId', result.userId);
    c.set('userEmail', '');
    c.set('authType', 'pat');
    if (result.accountId) c.set('accountId', result.accountId);
    if (result.projectId) c.set('tokenProjectId', result.projectId);
    // Token identity for the IAM engine. When the PAT has narrowing
    // policies attached, authorize() evaluates only the token's policies
    // instead of inheriting the minter's permissions.
    if (result.tokenId) c.set('iamTokenId', result.tokenId);
    setSentryUser({ id: result.userId, accountId: result.accountId });
    setContextField('userId', result.userId);
    if (result.accountId) setContextField('accountId', result.accountId);
    await next();
    return;
  }

  // Fast path: verify JWT locally (no network roundtrip)
  const local = await verifySupabaseJwt(token);
  if (local.ok) {
    c.set('userId', local.userId);
    c.set('userEmail', local.email);
    c.set('authType', 'supabase');
    // Authenticator Assurance Level — 'aal1' = password-only,
    // 'aal2' = MFA-verified. Surfaced for IAM policy conditions that
    // require MFA on sensitive actions.
    if (local.payload.aal) c.set('mfaAal', local.payload.aal);
    // Session identity surfaced for the per-account session gate
    // (idle/lifetime/force-logout). `iat` is the seconds-epoch the
    // current access token was issued — Supabase keeps it constant
    // across refreshes for the same root session.
    if (local.payload.session_id) c.set('sessionId', local.payload.session_id);
    if (typeof (local.payload as { iat?: number }).iat === 'number') {
      c.set('sessionIat', (local.payload as { iat: number }).iat);
    }
    // SAML JIT — no-ops when the JWT isn't from a SAML provider. We
    // don't block the request on sync failures since the user already
    // authenticated; failures are logged for ops review.
    syncSsoMembership({
      userId: local.userId,
      email: local.email,
      jwtPayload: local.payload as unknown as Record<string, unknown>,
    }).catch((err) => {
      console.warn('[auth] SAML JIT sync failed', err);
    });
    setSentryUser({ id: local.userId, email: local.email });
    setContextField('userId', local.userId);
    setContextField('userEmail', local.email);
    await next();
    return;
  }

  // Local verification unavailable (JWKS not loaded yet) — fall back to network
  if (local.reason !== 'no-keys' && local.reason !== 'no-key-for-kid') {
    // Token is definitively invalid (bad signature, expired, malformed)
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  try {
    const supabase = getSupabase();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new HTTPException(401, { message: 'Invalid or expired token' });
    }

    c.set('userId', user.id);
    c.set('userEmail', user.email || '');
    c.set('authType', 'supabase');
    setSentryUser({ id: user.id, email: user.email || undefined });
    setContextField('userId', user.id);
    setContextField('userEmail', user.email || '');
    await next();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    console.error('Auth error:', err);
    throw new HTTPException(401, { message: 'Authentication failed' });
  }
}

/**
 * Combined auth — accepts Kortix tokens OR Supabase JWTs.
 *
 * Token resolution order:
 *   1. Authorization: Bearer <token> header
 *   2. __preview_session cookie (set via POST /v1/p/auth)
 *
 * Used for:
 *   - Preview proxy routes (/v1/p/{sandboxId}/{port}/*)
 *   - Cron, deployment, secrets, providers, servers, queue, tunnel routes
 *   - SSE stream endpoints (clients use fetch() with Authorization header)
 *
 * Sets userId and userEmail in context regardless of token type.
 * For preview proxy routes, also sets/refreshes the session cookie.
 */
export async function combinedAuth(c: Context, next: Next) {
  // Skip auth for CORS preflight — OPTIONS never carries auth tokens.
  if (c.req.method === 'OPTIONS') {
    await next();
    return;
  }

  const previewSandboxId = extractPreviewSandboxId(c.req.path);

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
    // Last resort: check query param for preview proxy routes and SSE endpoints.
    // Browser WebSocket API can't set custom headers, so PTY terminals
    // and other WS clients pass the token as ?token=<jwt>.
    // EventSource (SSE) also can't set headers, so provision-stream uses this.
    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get('token');
    if (queryToken && (
      c.req.path.startsWith('/v1/p/') ||
      c.req.path.includes('/provision-stream')
    )) {
      token = queryToken;
    }
  }

  if (!token) {
    throw new HTTPException(401, { message: 'Missing authentication token' });
  }

  // Determine if this is a preview proxy route (for cookie management)
  const isPreviewRoute = c.req.path.startsWith('/v1/p/') || c.req.path === '/v1/p';

  // 0. CLI Personal Access Token — carries a real user_id.
  if (isAccountToken(token)) {
    const patResult = await validateAccountToken(token);
    if (!patResult.isValid || !patResult.userId) {
      throw new HTTPException(401, { message: patResult.error || 'Invalid PAT' });
    }
    if (patResult.projectId) {
      enforceTokenProjectScope(c, patResult.projectId);
    }
    c.set('userId', patResult.userId);
    c.set('userEmail', '');
    c.set('authType', 'pat');
    if (patResult.accountId) c.set('accountId', patResult.accountId);
    if (patResult.projectId) c.set('tokenProjectId', patResult.projectId);
    setSentryUser({ id: patResult.userId, accountId: patResult.accountId });
    setContextField('userId', patResult.userId);
    if (patResult.accountId) setContextField('accountId', patResult.accountId);
    if (isPreviewRoute) setPreviewSessionCookie(c, token);
    await next();
    return;
  }

  // 1. Try Kortix token (kortix_ or kortix_sb_) — used by agents inside the sandbox
  if (isKortixToken(token)) {
    const result = await validateSecretKey(token);
    if (!result.isValid) {
      throw new HTTPException(401, { message: result.error || 'Invalid Kortix token' });
    }
    if (previewSandboxId && !(await canAccessPreviewSandbox({
      previewSandboxId,
      accountId: result.accountId,
    }))) {
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
    await next();
    return;
  }

  // 2. Try Supabase JWT — fast path: local verification (no network roundtrip)
  const local = await verifySupabaseJwt(token);
  if (local.ok) {
    if (previewSandboxId && !(await canAccessPreviewSandbox({
      previewSandboxId,
      userId: local.userId,
    }))) {
      throw new HTTPException(403, { message: 'Not authorized to access this sandbox' });
    }
    c.set('userId', local.userId);
    c.set('userEmail', local.email);
    c.set('authType', 'supabase');
    setSentryUser({ id: local.userId, email: local.email });
    setContextField('userId', local.userId);
    setContextField('userEmail', local.email);
    if (isPreviewRoute) setPreviewSessionCookie(c, token);
    await next();
    return;
  }

  // Token is definitively bad (bad sig, expired, malformed) — reject immediately
  if (local.reason !== 'no-keys' && local.reason !== 'no-key-for-kid') {
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }

  // JWKS not yet loaded — fall back to network getUser() call
  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new HTTPException(401, { message: 'Invalid or expired token' });
    }

    if (previewSandboxId && !(await canAccessPreviewSandbox({
      previewSandboxId,
      userId: user.id,
    }))) {
      throw new HTTPException(403, { message: 'Not authorized to access this sandbox' });
    }

    c.set('userId', user.id);
    c.set('userEmail', user.email || '');
    c.set('authType', 'supabase');
    setSentryUser({ id: user.id, email: user.email || undefined });
    setContextField('userId', user.id);
    setContextField('userEmail', user.email || '');
    if (isPreviewRoute) setPreviewSessionCookie(c, token);
    await next();
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    console.error('[AUTH] Error:', err);
    throw new HTTPException(401, { message: 'Authentication failed' });
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Set (or refresh) the preview session cookie.
 * Scoped to /v1/p/ so it only applies to preview proxy routes.
 * SameSite=Lax allows the cookie on same-site navigations and sub-resource loads.
 * Max-Age=3600 (1 hour) — the frontend refreshes the token periodically.
 */
function setPreviewSessionCookie(c: Context, token: string) {
  const encoded = encodeURIComponent(token);
  c.header(
    'Set-Cookie',
    `${PREVIEW_SESSION_COOKIE}=${encoded}; Path=/v1/p/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
    { append: true },
  );
}

function extractPreviewSandboxId(path: string): string | null {
  const match = path.match(/^\/v1\/p\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  const segment = match[1];
  return segment === 'auth' || segment === 'share' ? null : segment;
}

/**
 * A project-scoped CLI PAT can only act on its bound project. Reject
 * the request if:
 *   - the URL targets a `:projectId` parameter that doesn't match, OR
 *   - the URL is an account-level route (`/v1/accounts/*` other than
 *     `/v1/accounts/me`, which we allow as a self-identity probe), OR
 *   - the URL is a webhook / preview / system route the token has no
 *     business hitting.
 *
 * Throws HTTPException(403) so the calling middleware aborts the chain.
 */
function enforceTokenProjectScope(c: Context, tokenProjectId: string): void {
  const path = c.req.path;

  // Whitelist a couple of self-identity probes the CLI hits even for
  // project-scoped tokens. `/v1/accounts/me` lets the agent confirm
  // "what project am I bound to?".
  if (path === '/v1/accounts/me') return;

  // Reject other account-level routes outright.
  if (path.startsWith('/v1/accounts/') || path === '/v1/accounts') {
    throw new HTTPException(403, {
      message: 'Project-scoped token cannot call account-level routes',
    });
  }

  // `/v1/projects/:projectId/...` — require the URL id to match.
  const m = path.match(/^\/v1\/projects\/([^/]+)/);
  if (m) {
    const urlProjectId = m[1];
    if (urlProjectId !== tokenProjectId) {
      throw new HTTPException(403, {
        message: 'Project-scoped token cannot access a different project',
      });
    }
    return;
  }

  // Bare `/v1/projects` (list) is also account-scoped: a project-bound
  // token shouldn't enumerate other projects.
  if (path === '/v1/projects') {
    throw new HTTPException(403, {
      message: 'Project-scoped token cannot list projects',
    });
  }

  // All other surfaces (router, billing, channels, etc.) are
  // account-level — refuse.
  throw new HTTPException(403, {
    message: 'Project-scoped token cannot call this surface',
  });
}
