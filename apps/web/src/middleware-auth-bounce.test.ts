import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import {
  AUTH_BOUNCE_COOKIE,
  LAST_PROJECT_COOKIE,
  parseAuthBounceOwner,
} from '@/lib/onboarding/landing-destination';
import { middleware } from './middleware';

/**
 * The middleware bounce has to say WHO it bounced.
 *
 * `/auth?redirect=<path>` on its own is an anonymous instruction to replay a
 * path. Everything downstream then has to guess whether the person now signing
 * in is the person the path belonged to. Signing in as B on a screen bounced
 * from A's project sent B to A's "Request access" page, because the only guard
 * in place ran for brand-new accounts and B is an existing one.
 *
 * This drives the REAL middleware — no Supabase mock — because the value that
 * matters is the one actually written to `Set-Cookie`.
 */

const FOREIGN_PROJECT = '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c';
const USER_A = '11111111-1111-1111-1111-111111111111';

/** A logged-out browser asking for a private path. */
function bounceRequest(path: string, cookie?: string): NextRequest {
  const request = new NextRequest(new Request(`https://dev.kortix.com${path}`));
  if (cookie) request.cookies.set(LAST_PROJECT_COOKIE, cookie);
  return request;
}

function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
}

/** The cookie value as the next request will read it back (one decode hop). */
function bounceCookieValue(response: Response): string | undefined {
  const header = setCookieFor(response, AUTH_BOUNCE_COOKIE);
  if (!header) return undefined;
  return decodeURIComponent(header.slice(`${AUTH_BOUNCE_COOKIE}=`.length).split(';')[0]);
}

describe('middleware bounce attribution', () => {
  test('still bounces an unauthenticated request to /auth with its path', async () => {
    const response = await middleware(bounceRequest(FOREIGN_PROJECT));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      `https://dev.kortix.com/auth?redirect=${encodeURIComponent(FOREIGN_PROJECT)}`,
    );
  });

  test('attributes the bounce to the owner of the remembered project', async () => {
    // The session is already gone by the time the bounce is built — that is the
    // whole shape of the bug (a rotated refresh token, or the self-heal that
    // nulls `user` on the way past). The remembered project outlives the token
    // and is the only identity left to attach.
    const response = await middleware(
      bounceRequest(FOREIGN_PROJECT, `${USER_A}:319395c1-9c3f-41b4-ac6c-9539a12dbb7c`),
    );

    expect(parseAuthBounceOwner(bounceCookieValue(response))).toBe(USER_A);
  });

  test('an unattributed bounce is written as such, not skipped', async () => {
    // No session, no remembered project. The cookie must still be written with
    // an EMPTY owner: that is what tells the next sign-in "this bounce names
    // nobody", which is different from "no bounce happened" only in that both
    // must keep the return URL. Writing nothing at all would be fine today and
    // wrong the moment anyone reads absence as attribution.
    const value = bounceCookieValue(await middleware(bounceRequest(FOREIGN_PROJECT)));

    expect(value).toBeDefined();
    expect(parseAuthBounceOwner(value)).toBe('');
  });

  test('a legacy bare-project-id cookie attributes nobody', async () => {
    // Written before ownership binding existed, so it names a project and no
    // user. Guessing an owner from it would demote real sign-ins.
    const response = await middleware(
      bounceRequest(FOREIGN_PROJECT, '319395c1-9c3f-41b4-ac6c-9539a12dbb7c'),
    );

    expect(parseAuthBounceOwner(bounceCookieValue(response))).toBe('');
  });

  test('the bounced path rides along, cookie-safe', async () => {
    // A path can legally hold characters a cookie value cannot. The header must
    // survive one, and the owner half must still parse out of it.
    const response = await middleware(
      bounceRequest(
        '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c?tab=a,b',
        `${USER_A}:319395c1-9c3f-41b4-ac6c-9539a12dbb7c`,
      ),
    );
    const value = bounceCookieValue(response) as string;

    expect(value.includes(',')).toBe(false);
    expect(value.includes(';')).toBe(false);
    expect(parseAuthBounceOwner(value)).toBe(USER_A);
    expect(decodeURIComponent(value.slice(value.indexOf(':') + 1))).toBe(
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c?tab=a,b',
    );
  });

  test('a public route is not a bounce and gets no cookie', async () => {
    const response = await middleware(bounceRequest('/pricing'));

    expect(setCookieFor(response, AUTH_BOUNCE_COOKIE)).toBeUndefined();
  });
});
