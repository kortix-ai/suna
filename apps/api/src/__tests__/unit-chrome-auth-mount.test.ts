/**
 * The Kortix in Chrome routes must be REACHABLE, not merely correct. The same
 * failure as unit-boot-timeline-auth-mount.test.ts: a route mounted without auth
 * middleware, or a session-scoped sandbox credential the scope gate refuses, is
 * a silent 401 or 403. The sandbox calls `kortix chrome use` through
 * `POST /v1/chrome/attach` with its session-scoped KORTIX_TOKEN.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
const authScope = readFileSync(new URL('../middleware/auth-scope.ts', import.meta.url), 'utf8');
const deadline = readFileSync(new URL('../middleware/request-deadline.ts', import.meta.url), 'utf8');
const dispatch = readFileSync(new URL('../inbound-dispatch.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('kortix chrome is reachable', () => {
  test('auth runs before both routers', () => {
    const route = appSource.indexOf("app.route('/v1/chrome/connections', chromeConnectionsApp)");
    expect(route).toBeGreaterThan(-1);
    for (const mount of [
      "app.use('/v1/chrome/*', supabaseAuth)",
    ]) {
      const at = appSource.indexOf(mount);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(route);
    }
    expect(appSource.indexOf("app.route('/v1/chrome', chromeApp)")).toBeGreaterThan(-1);
  });

  test('the session-scoped credential passes the token-project-scope gate on attach and release', () => {
    const start = authScope.indexOf('const SESSION_BOUND_PLATFORM_SINKS');
    const set = authScope.slice(start, start + 800);
    expect(set).toContain("'/v1/chrome/attach'");
    expect(set).toContain("'/v1/chrome/release'");
  });

  test('a session-scoped credential may list browsers, and only with GET', () => {
    expect(authScope).toContain("opts.sessionBound && c.req.method === 'GET' && path === '/v1/chrome/connections'");
  });

  test('attach is exempt from the 25 s request deadline: it waits for the person', () => {
    expect(deadline).toContain('/^\\/v1\\/chrome\\/attach$/');
  });

  test('the control socket is upgraded in the dispatcher and served in index.ts', () => {
    expect(dispatch).toContain("url.pathname === '/v1/chrome/ws'");
    for (const handler of ['open', 'message', 'close']) {
      expect(server).toContain(`chromeWsHandlers.${handler}(`);
    }
  });
});
