/**
 * The boot-timeline route must be REACHABLE, not merely correct.
 *
 * This is the test that was missing. The handler's own logic was fine; nothing
 * ever asked whether a request could get to it. `auth` from openapi/index.ts is
 * `{ security: [{ bearerAuth: [] }] }` — OpenAPI metadata, NOT middleware — and
 * `/v1/platform` was mounted with no auth middleware, so `authType` was never
 * set and the handler's `authType !== 'apiKey'` guard returned 403 for every
 * relay. The daemon fire-and-forgets the call, so it failed in silence and no
 * in-guest boot timeline was ever recorded.
 *
 * That also made the sandbox egress pin inert: the pin is written on this
 * route, so a route nobody can reach pins nobody, and every session stayed
 * `unpinned` — which the broker allows.
 *
 * Source-level rather than a live request because the failure was in the WIRING
 * (which middleware is mounted where), and that is what these assertions read.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const openapi = readFileSync(new URL('../openapi/index.ts', import.meta.url), 'utf8');

describe('boot-timeline is actually reachable', () => {
  test('auth middleware is mounted on the route', () => {
    expect(index).toContain("app.use('/v1/platform/boot-timeline', supabaseAuth)");
  });

  test('the mount comes BEFORE the platform router', () => {
    // Hono runs middleware registered before the matching route. Registering
    // this after `app.route('/v1/platform', …)` would leave it dead.
    const use = index.indexOf("app.use('/v1/platform/boot-timeline', supabaseAuth)");
    const route = index.indexOf("app.route('/v1/platform', platformApp)");
    expect(use).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(-1);
    expect(use).toBeLessThan(route);
  });

  test('the runtime-projection push is mounted the same way, before the router', () => {
    // Second route on the same pattern: the daemon fire-and-forgets this push
    // too, so an unmounted middleware would be silent 403s and an empty
    // projection store rather than a visible failure.
    const use = index.indexOf("app.use('/v1/platform/runtime-projection', supabaseAuth)");
    const route = index.indexOf("app.route('/v1/platform', platformApp)");
    expect(use).toBeGreaterThan(-1);
    expect(use).toBeLessThan(route);
  });

  test('the whole platform sub-app is NOT blanket-authenticated', () => {
    // `/sandbox/version` and the github-app setup callbacks are deliberately
    // public; a wildcard mount would break them.
    expect(index).not.toContain("app.use('/v1/platform/*', supabaseAuth)");
  });

  test('openapi `auth` is metadata, so a route cannot rely on it for identity', () => {
    // Pinning the root cause: if this ever becomes real middleware the comment
    // above (and this test) should change deliberately, not by accident.
    expect(openapi).toContain("export const auth: Pick<RouteConfig, 'security'>");
  });
});
