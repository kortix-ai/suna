import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dir, '../../../../../..');
const LAYOUT = resolve(WEB_ROOT, 'src/app/[locale]/(app)/projects/[id]/layout.tsx');
const MIDDLEWARE = resolve(WEB_ROOT, 'src/middleware.ts');

/**
 * The project layout deliberately does NOT verify the session: middleware
 * already did, and doing it again cost a second GoTrue round-trip on every
 * project switch and hard load.
 *
 * That is only safe while middleware default-denies `/projects`. `PUBLIC_ROUTES`
 * is the one route list that skips middleware's auth gate — the adjacent
 * static-canvas fast path was deleted because both of its routes already sat
 * in `PUBLIC_ROUTES` — so every route list in the file is pinned here. Adding
 * `/projects` to any of them fails this suite loudly instead of silently
 * rendering the project shell to a signed-out visitor.
 */
describe('project layout auth contract', () => {
  test('middleware does not treat /projects as a public route', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');
    const publicRoutesStart = source.indexOf('const PUBLIC_ROUTES');
    const markdownNegotiationRoutesStart = source.indexOf('const MARKDOWN_NEGOTIATION_ROUTES');

    // Guard the markers themselves: if either is renamed or deleted, indexOf
    // returns -1 and the slice below silently runs to end-of-file (or is
    // empty), which would make the /projects check below pass for the wrong
    // reason instead of failing loudly.
    expect(publicRoutesStart).toBeGreaterThan(-1);
    expect(markdownNegotiationRoutesStart).toBeGreaterThan(publicRoutesStart);

    const publicRoutes = source.slice(publicRoutesStart, markdownNegotiationRoutesStart);

    expect(publicRoutes.length).toBeGreaterThan(0);
    expect(publicRoutes).not.toMatch(/'\/projects'/);
  });

  test('the static canvases ride PUBLIC_ROUTES — there is no second auth-skipping list', () => {
    const source = readFileSync(MIDDLEWARE, 'utf8');
    const publicRoutesStart = source.indexOf('const PUBLIC_ROUTES');
    const markdownNegotiationRoutesStart = source.indexOf('const MARKDOWN_NEGOTIATION_ROUTES');
    expect(publicRoutesStart).toBeGreaterThan(-1);
    expect(markdownNegotiationRoutesStart).toBeGreaterThan(publicRoutesStart);

    // The static-canvas fast path was deleted because both of its routes
    // already sat in PUBLIC_ROUTES. If either canvas leaves the list, a
    // visitor could lose it — or someone re-introduces a second, adjacent
    // auth-skipping list, which is exactly how /projects once nearly shipped
    // public.
    const publicRoutes = source.slice(publicRoutesStart, markdownNegotiationRoutesStart);
    expect(publicRoutes).toContain("'/game-of-life'");
    expect(publicRoutes).toContain("'/rauch'");
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
