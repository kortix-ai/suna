import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { sanitizeAuthReturnUrl } from '@/lib/auth/return-url';

const WEB_SRC = resolve(import.meta.dir, '../..');

/** Source with comments removed, so an assertion can never match prose. */
function code(relPath: string): string {
  return readFileSync(resolve(WEB_SRC, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('/logout signs the user out', () => {
  test('runs the ONE shared sign-out, not a second implementation of it', () => {
    const page = code('app/logout/page.tsx');
    expect(page).toContain('performSignOut()');
    expect(page).toContain("from '@/lib/auth/perform-sign-out'");
  });

  test('does not hand-roll any part of the exit path', () => {
    const page = code('app/logout/page.tsx');
    // Each of these would be a second copy of something performSignOut owns:
    // the session end, the client-state reset, and the hard navigation that
    // discards Next's caches. A soft router push would keep them.
    expect(page).not.toContain('supabase.auth.signOut');
    expect(page).not.toContain('resetClientState');
    expect(page).not.toContain('router.push');
    expect(page).not.toContain('router.replace');
  });
});

describe('/logout cannot become a sign-in loop', () => {
  test('is public, so a signed-out visitor is never bounced to sign IN first', () => {
    const middleware = code('middleware.ts');
    const start = middleware.indexOf('const PUBLIC_ROUTES');
    const end = middleware.indexOf('];', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(middleware.slice(start, end)).toContain("'/logout'");
  });

  test('a sign-in can never RETURN to it — behavioural, through the real resolver', () => {
    // Without this, `?redirect=/logout` from a stale link would sign the user
    // in and immediately sign them back out.
    expect(sanitizeAuthReturnUrl('/logout')).toBe(PROJECT_LANDING_PATH);
    expect(sanitizeAuthReturnUrl('/logout?from=somewhere')).toBe(PROJECT_LANDING_PATH);
    expect(sanitizeAuthReturnUrl('/logout/anything')).toBe(PROJECT_LANDING_PATH);
  });

  test('the guard is specific — a path merely STARTING with those letters still works', () => {
    // `/logout-survey` is a different route; the prefix match is on segment
    // boundaries, so it must survive.
    expect(sanitizeAuthReturnUrl('/logout-survey')).toBe('/logout-survey');
  });
});
