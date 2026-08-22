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
 * That is only safe while middleware default-denies `/projects`. Middleware has
 * TWO route lists that skip its auth gate — `PUBLIC_ROUTES` and the adjacent
 * `STATIC_PUBLIC_ROUTES` — so both are pinned here. Adding `/projects` to
 * either fails this suite loudly instead of silently rendering the project
 * shell to a signed-out visitor.
 */
describe('project layout auth contract', () => {
  test('middleware does not treat /projects as a public route', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');
    const publicRoutesStart = source.indexOf('const PUBLIC_ROUTES');
    const staticPublicRoutesStart = source.indexOf('const STATIC_PUBLIC_ROUTES');

    // Guard the markers themselves: if either is renamed or deleted, indexOf
    // returns -1 and the slice below silently runs to end-of-file (or is
    // empty), which would make the /projects check below pass for the wrong
    // reason instead of failing loudly.
    expect(publicRoutesStart).toBeGreaterThan(-1);
    expect(staticPublicRoutesStart).toBeGreaterThan(-1);

    const publicRoutes = source.slice(publicRoutesStart, staticPublicRoutesStart);

    expect(publicRoutes.length).toBeGreaterThan(0);
    expect(publicRoutes).not.toMatch(/'\/projects'/);
  });

  test('middleware does not treat /projects as a static public route', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');
    const staticPublicRoutesStart = source.indexOf('const STATIC_PUBLIC_ROUTES');
    const markdownNegotiationRoutesStart = source.indexOf('const MARKDOWN_NEGOTIATION_ROUTES');

    // STATIC_PUBLIC_ROUTES is a second, semantically identical auth-skipping
    // list sitting directly below PUBLIC_ROUTES (middleware.ts ~102-105):
    // routes.some(pathname === route) short-circuits to NextResponse.next()
    // before any Supabase client is created. It is also the more likely place
    // a future author adds a route, since it is the adjacent list. Same
    // marker guard as above, for the same reason.
    expect(staticPublicRoutesStart).toBeGreaterThan(-1);
    expect(markdownNegotiationRoutesStart).toBeGreaterThan(-1);

    const staticPublicRoutes = source.slice(staticPublicRoutesStart, markdownNegotiationRoutesStart);

    expect(staticPublicRoutes.length).toBeGreaterThan(0);
    expect(staticPublicRoutes).not.toMatch(/'\/projects'/);
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
