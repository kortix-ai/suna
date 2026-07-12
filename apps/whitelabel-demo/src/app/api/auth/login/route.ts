/**
 * Wrapper-mode login: email + (any password, or `DEMO_PASSWORD` if set — see
 * `checkDemoCredentials`). No user directory; `userId` is just the email.
 *
 * Returns the signed session token in the JSON body (the client stores it and
 * sends it as `Authorization: Bearer …` for the SDK's REST/SSE calls) AND sets
 * it as an HttpOnly cookie (so the preview iframe's same-origin requests,
 * which can't attach headers, still carry a valid session).
 *
 * Rate-limited per client IP (there's no `userId` yet at this point — the
 * caller isn't authenticated) via the same token-bucket `consumeRateLimit`
 * used post-auth by the other routes, so an unauthenticated caller can't
 * brute-force `DEMO_PASSWORD` (or hammer `signSession`) unbounded.
 */

import { SESSION_COOKIE_NAME, checkDemoCredentials, signSession } from '@/server/auth';
import { consumeRateLimit } from '@/server/rate-limit';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days — matches signSession's TTL

/** Best-effort client IP from proxy headers — this app always sits behind one in deployment. */
function clientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

export async function POST(req: NextRequest) {
  if (!process.env.KORTIX_API_KEY) {
    return Response.json({ error: 'Wrapper mode is not enabled on this server.' }, { status: 500 });
  }

  // Keyed separately from the post-auth per-userId buckets (`login:` prefix)
  // so a client IP can never collide with an authenticated userId string.
  const limited = consumeRateLimit(`login:${clientIp(req)}`);
  if (!limited.ok) {
    return Response.json(
      { error: 'Too many login attempts. Try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(Math.ceil((limited.retryAfterMs ?? 1000) / 1000)) } },
    );
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!checkDemoCredentials(email, password)) {
    return Response.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  let token: string;
  try {
    token = signSession(email);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  const res = Response.json({ token, userId: email });
  res.headers.append(
    'Set-Cookie',
    [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      'Path=/',
      `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      'HttpOnly',
      'SameSite=Lax',
      ...(process.env.NODE_ENV === 'production' ? ['Secure'] : []),
    ].join('; '),
  );
  return res;
}
