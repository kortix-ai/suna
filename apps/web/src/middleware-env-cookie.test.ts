import { afterEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import {
  ENVIRONMENT_ACCESS_COOKIE,
  ENVIRONMENT_PROTECTION_USERNAME,
  deriveEnvironmentAccessCookie,
} from '@/lib/environment-protection';
import { middleware } from './middleware';

/**
 * Which middleware responses carry the environment-access cookie is part of
 * the gate's contract. Every authorized response renews the sliding window;
 * the two responses that precede the authorization decision — the
 * sensitive-file 404 and the protection 401 — must stay cookie-free: they
 * grant no access, so they must not slide a window. Pinned BEFORE the
 * single-exit restructure of middleware.ts so the restructure can prove the
 * wrapper's placement did not move.
 */

const PROTECTION_PASSWORD = 'test-protection-pw';
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  delete env.WEB_PROTECTION_ENABLED;
  delete env.WEB_PROTECTION_PASSWORD;
});

function basicAuthRequest(path: string): NextRequest {
  const credentials = Buffer.from(
    `${ENVIRONMENT_PROTECTION_USERNAME}:${PROTECTION_PASSWORD}`,
  ).toString('base64');
  return new NextRequest(
    new Request(`https://dev.kortix.com${path}`, {
      headers: { authorization: `Basic ${credentials}` },
    }),
  );
}

function accessCookieFor(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${ENVIRONMENT_ACCESS_COOKIE}=`));
}

describe('environment-access cookie placement', () => {
  test('a sensitive-file probe answers 404 without the access cookie, even when authorized', async () => {
    env.WEB_PROTECTION_ENABLED = 'true';
    env.WEB_PROTECTION_PASSWORD = PROTECTION_PASSWORD;

    const response = await middleware(basicAuthRequest('/.env'));

    expect(response.status).toBe(404);
    expect(accessCookieFor(response)).toBeUndefined();
  });

  test('a protection denial answers 401 without the access cookie', async () => {
    env.WEB_PROTECTION_ENABLED = 'true';
    env.WEB_PROTECTION_PASSWORD = PROTECTION_PASSWORD;

    const response = await middleware(
      new NextRequest(new Request('https://dev.kortix.com/projects')),
    );

    expect(response.status).toBe(401);
    expect(accessCookieFor(response)).toBeUndefined();
  });

  test('an authorized public page renews the access cookie from a Basic challenge', async () => {
    env.WEB_PROTECTION_ENABLED = 'true';
    env.WEB_PROTECTION_PASSWORD = PROTECTION_PASSWORD;

    const response = await middleware(basicAuthRequest('/pricing'));

    expect(accessCookieFor(response)).toBeDefined();
  });

  test('an authorized public page renews the access cookie from the cookie path', async () => {
    env.WEB_PROTECTION_ENABLED = 'true';
    env.WEB_PROTECTION_PASSWORD = PROTECTION_PASSWORD;

    const expected = await deriveEnvironmentAccessCookie(PROTECTION_PASSWORD);
    const request = new NextRequest(new Request('https://dev.kortix.com/pricing'));
    request.cookies.set(ENVIRONMENT_ACCESS_COOKIE, expected);

    const response = await middleware(request);

    expect(accessCookieFor(response)).toBeDefined();
  });
});
