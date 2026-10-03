import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MFA_PENDING_COOKIE, middlewareOwesTotpChallenge } from '@/lib/auth/mfa-challenge';

/**
 * The middleware holds an app path behind the TOTP challenge while it is
 * pending.
 *
 * The sign-in completions already route a verified-factor session to
 * /auth/mfa; this gate is what makes the challenge real rather than a
 * polite first redirect: while the session is aal1 and the pending cookie is
 * set, a typed URL or bookmark cannot reach the app.
 *
 * The decision is a pure function (`middlewareOwesTotpChallenge`) — a real
 * aal1 JWT would need a signing key, and `mock.module` is process-wide in
 * this workspace, so mocking the identity resolver here would leak into the
 * resolver's own test file. The WIRING is asserted on the middleware source,
 * in this directory's convention (`middleware-desktop-routes.test.ts`).
 */

const pending = (pathname: string, isPublicRoute = false) =>
  middlewareOwesTotpChallenge({
    aal: 'aal1',
    pendingCookie: '1',
    isPublicRoute,
    pathname,
  });

describe('middleware TOTP gate — the decision', () => {
  test('an aal1 session with a pending challenge is held', () => {
    expect(pending('/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c')).toBe(true);
  });

  test('an aal2 session is never held, even with a stale pending cookie', () => {
    expect(
      middlewareOwesTotpChallenge({
        aal: 'aal2',
        pendingCookie: '1',
        isPublicRoute: false,
        pathname: '/projects',
      }),
    ).toBe(false);
  });

  test('an aal1 session without the pending cookie renders the app', () => {
    // The factor-less case: aal1 is its normal level, and no sign-in
    // completion ever set the flag for it.
    expect(
      middlewareOwesTotpChallenge({
        aal: 'aal1',
        pendingCookie: undefined,
        isPublicRoute: false,
        pathname: '/projects',
      }),
    ).toBe(false);
  });

  test('a session whose aal could not be read is never held', () => {
    // Identity resolution could not settle the level: fail open here, the
    // auth gate above already decided this is a signed-in request.
    expect(
      middlewareOwesTotpChallenge({
        aal: undefined,
        pendingCookie: '1',
        isPublicRoute: false,
        pathname: '/projects',
      }),
    ).toBe(false);
  });

  test('the homepage of a pending session is held, a public marketing route is not', () => {
    expect(pending('/')).toBe(true);
    expect(pending('/pricing', true)).toBe(false);
  });
});

describe('middleware TOTP gate — the wiring', () => {
  const source = readFileSync(join(import.meta.dir, 'middleware.ts'), 'utf8');

  test('the middleware feeds the real cookie and identity into the gate and redirects to the challenge', () => {
    expect(source).toContain('middlewareOwesTotpChallenge({');
    expect(source).toContain('request.cookies.get(MFA_PENDING_COOKIE)?.value');
    expect(source).toContain('aal: user?.aal');
    expect(source).toContain('redirectPreservingSession(challengeUrl)');
    // The challenge carries the path the visitor was headed to.
    expect(source).toContain('mfaChallengePath(');
  });

  test('the gate runs after identity resolution, before the landing fast path', () => {
    const gate = source.indexOf('middlewareOwesTotpChallenge({');
    const selfHeal = source.indexOf('const bounceOwnerId =');
    const fastPath = source.indexOf("if (pathname === '/' && user)");
    expect(gate).toBeGreaterThan(selfHeal);
    expect(fastPath).toBeGreaterThan(gate);
  });
});
