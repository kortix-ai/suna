import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { middleware } from './middleware';

/**
 * `/game-of-life` and `/rauch` are the two visual, static public canvases.
 * Pinned BEFORE the static-canvas fast path was deleted from middleware.ts:
 * both routes already sit in `PUBLIC_ROUTES`, so the general public-route
 * rewrite must keep producing the identical response after the fast path is
 * gone — same rewrite target, same cookie-locale selection, and still no
 * Supabase session work.
 */

const ORIGIN = 'https://dev.kortix.com';

const GERMAN_SESSION = `base64-${Buffer.from(
  JSON.stringify({ user: { user_metadata: { locale: 'de' } } }),
).toString('base64url')}`;

function request(path: string, cookie?: string): NextRequest {
  const req = new NextRequest(new Request(`${ORIGIN}${path}`));
  if (cookie) req.cookies.set(KORTIX_SUPABASE_AUTH_COOKIE, cookie);
  return req;
}

describe('static public canvases rewrite like every public route', () => {
  test('the two canvases rewrite onto the [locale] segment in English', async () => {
    for (const path of ['/game-of-life', '/rauch']) {
      const response = await middleware(request(path));
      expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/en${path}`);
      expect(response.headers.get('x-locale')).toBe('en');
    }
  });

  test('a path under a canvas rewrites with the canvas as the prefix', async () => {
    const response = await middleware(request('/game-of-life/patterns'));
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      `${ORIGIN}/en/game-of-life/patterns`,
    );
  });

  test('the session-cookie locale picks the canvas language, with no session work', async () => {
    for (const path of ['/game-of-life', '/rauch']) {
      const response = await middleware(request(path, GERMAN_SESSION));
      expect(response.headers.get('x-middleware-rewrite')).toBe(`${ORIGIN}/de${path}`);
      // No Supabase round trip on the way out: these pages are identical for
      // every visitor, so the middleware must not set or refresh anything.
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });
});
