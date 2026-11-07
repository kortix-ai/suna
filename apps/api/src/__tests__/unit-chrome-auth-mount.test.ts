/**
 * The Kortix in Chrome routes must be REACHABLE, not merely correct. The same
 * failure as unit-boot-timeline-auth-mount.test.ts: a route mounted without auth
 * middleware, or a session-scoped sandbox credential the scope gate refuses, is
 * a silent 401 or 403. The sandbox calls `kortix chrome use` through
 * `POST /v1/chrome/attach` with its session-scoped KORTIX_TOKEN.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { workspaceFenceVerdict } from '../middleware/workspace-binding';

const WS = '11111111-1111-4111-8111-111111111111';
const deps = { sandboxWorkspace: async () => null, accountWorkspace: async () => null };

const appSource = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
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

  test('the session-scoped credential passes the workspace fence on attach and release', async () => {
    const session = { workspaceId: WS, sessionBound: true };
    for (const path of ['/v1/chrome/attach', '/v1/chrome/release']) {
      expect(await workspaceFenceVerdict('POST', path, session, deps)).toEqual({ allowed: true });
    }
  });

  test('a session-scoped credential may list browsers, and only with GET', async () => {
    const session = { workspaceId: WS, sessionBound: true };
    expect(await workspaceFenceVerdict('GET', '/v1/chrome/connections', session, deps)).toEqual({ allowed: true });
    expect((await workspaceFenceVerdict('DELETE', '/v1/chrome/connections', session, deps)).allowed).toBe(false);
    expect(
      (await workspaceFenceVerdict('GET', '/v1/chrome/connections', { workspaceId: WS, sessionBound: false }, deps)).allowed,
    ).toBe(false);
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
