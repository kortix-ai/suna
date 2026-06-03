/**
 * Preview Auth Endpoint — POST /v1/p/auth
 *
 * Validates the user's JWT (from Authorization header) and sets a session
 * cookie (__preview_session) as a host-only cookie (no Domain= attribute).
 * This scopes the cookie to the exact origin that served the response,
 * enabling subdomain-based routing without ?token= on every request.
 *
 * Called by the frontend once on mount before loading a preview iframe.
 */

import { Hono } from 'hono';
import { validateSecretKey } from '../../repositories/api-keys';
import { isKortixToken } from '../../shared/crypto';
import { getSupabase } from '../../shared/supabase';

const PREVIEW_SESSION_COOKIE = '__preview_session';
const COOKIE_MAX_AGE = 3600; // 1 hour

const getAuthToken = new Hono();

getAuthToken.post('/', async (c) => {
  const authHeader = c.req.header('Authorization');
  let token: string | undefined;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  if (!token) {
    return c.json({ error: 'Missing Authorization header' }, 401);
  }

  // Validate token
  if (isKortixToken(token)) {
    const result = await validateSecretKey(token);
    if (!result.isValid) {
      return c.json({ error: result.error || 'Invalid Kortix token' }, 401);
    }
  } else {
    try {
      const supabase = getSupabase();
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) {
        return c.json({ error: 'Invalid or expired token' }, 401);
      }
    } catch {
      return c.json({ error: 'Authentication failed' }, 401);
    }
  }

  // Set session cookie — host-only (no Domain= attribute) so the browser
  // scopes it to the exact subdomain that served the response. This avoids
  // Chrome rejecting the cookie when Domain=localhost is treated as a public suffix.
  //
  // IMPORTANT: Path MUST be /v1/p/ — matching the combinedAuth middleware cookie
  // path. Using Path=/ would create a SECOND cookie at a different scope, causing
  // both to be sent on /v1/p/* requests and doubling the Cookie header size,
  // which leads to HTTP 431 (Request Header Fields Too Large).
  const encoded = encodeURIComponent(token);
  c.header(
    'Set-Cookie',
    `${PREVIEW_SESSION_COOKIE}=${encoded}; Path=/v1/p/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
    { append: true },
  );

  return c.json({ ok: true });
});

// Also support OPTIONS for CORS preflight
getAuthToken.options('/', (_c) => {
  return new Response(null, { status: 204 });
});

export { getAuthToken };
