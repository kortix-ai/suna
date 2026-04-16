import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validateSecretKey } from '../repositories/api-keys';
import { isKortixToken } from '../shared/crypto';
import { canAccessPreviewSandbox } from '../shared/preview-ownership';
import { getSupabase } from '../shared/supabase';
import { verifySupabaseJwt } from '../shared/jwt-verify';
import { config } from '../config';
import { setSentryUser } from '../lib/sentry';
import { setContextField } from '../lib/request-context';

// ─── Cookie name for preview session auth ────────────────────────────────────
const PREVIEW_SESSION_COOKIE = '__preview_session';

function isLocalPreviewBypassRequest(c: Context, previewSandboxId: string | null): boolean {
  if (!previewSandboxId) return false;
  if (previewSandboxId !== config.SANDBOX_CONTAINER_NAME) return false;

  try {
    const { hostname } = new URL(c.req.url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

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
  if (result.sandboxId) {
    c.set('sandboxId', result.sandboxId);
  }
  await next();
}

/**
 * Supabase JWT auth (for billing, platform, admin routes).
 * Header-only — sets userId and userEmail in context on success.
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

  // Fast path: verify JWT locally (no network roundtrip)
  const local = await verifySupabaseJwt(token);
  if (local.ok) {
    c.set('userId', local.userId);
    c.set('userEmail', local.email);
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

  if (isLocalPreviewBypassRequest(c, previewSandboxId)) {
    await next();
    return;
  }

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
    if (result.accountId) c.set('accountId', result.accountId);
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
    `${PREVIEW_SESSION_COOKIE}=${encoded}; Path=/v1/p/; HttpOnly; SameSite=Lax; Max-Age=3600`,
    { append: true },
  );
}

function extractPreviewSandboxId(path: string): string | null {
  const match = path.match(/^\/v1\/p\/([^/]+)(?:\/|$)/);
  if (!match) return null;
  const segment = match[1];
  return segment === 'auth' || segment === 'share' ? null : segment;
}
