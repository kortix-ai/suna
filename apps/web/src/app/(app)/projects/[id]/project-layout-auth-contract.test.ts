import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../../../..');
const LAYOUT = resolve(WEB_ROOT, 'src/app/(app)/projects/[id]/layout.tsx');
const MIDDLEWARE = resolve(WEB_ROOT, 'src/middleware.ts');

/**
 * The project layout deliberately does NOT verify the session: middleware
 * already did, and doing it again cost a second GoTrue round-trip on every
 * project switch and hard load.
 *
 * That is only safe while middleware default-denies `/projects`. These tests pin
 * that invariant, so making `/projects` public fails here loudly instead of
 * silently rendering the project shell to a signed-out visitor.
 */
describe('project layout auth contract', () => {
  test('middleware does not treat /projects as a public route', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');
    const publicRoutes = source.slice(
      source.indexOf('const PUBLIC_ROUTES'),
      source.indexOf('const STATIC_PUBLIC_ROUTES'),
    );

    expect(publicRoutes.length).toBeGreaterThan(0);
    expect(publicRoutes).not.toMatch(/'\/projects'/);
  });

  test('middleware still redirects unauthenticated non-public traffic to /auth', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');

    expect(source).toContain('if (authError || !user)');
    expect(source).toContain("url.pathname = '/auth'");
  });

  test('the project layout does not create a Supabase server client', () => {
    const source = readFileSync(LAYOUT, 'utf8');

    expect(source).not.toContain('@/lib/supabase/server');
    expect(source).not.toContain('auth.getUser');
  });
});
