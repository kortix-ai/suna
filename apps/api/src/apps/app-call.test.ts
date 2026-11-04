/**
 * The App-target call never follows a redirect: the App's own server answers
 * it, and a 3xx must not steer the request, or the ingress token it carries,
 * at another host. The App and its ingress are stubbed; the HTTP is real.
 */
import { afterAll, expect, mock, test } from 'bun:test';

const elsewhere: Array<{ token: string | null; body: string }> = [];
const internal = Bun.serve({
  port: 0,
  fetch: async (req) => {
    elsewhere.push({ token: req.headers.get('x-pt-preview-token'), body: await req.text() });
    return new Response('reached');
  },
});
const app = Bun.serve({
  port: 0,
  fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${internal.port}/admin` } }),
});

mock.module('../shared/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ routeKey: 'rk' }] }) }) }) },
}));
mock.module('./public-proxy-runtime', () => ({
  loadPublicApp: async () => ({ app: { appId: 'a' } }),
  ensureAppRuntimeRunning: async () => ({ provider: 'platinum', externalId: 'ext', runtimeId: 'rt' }),
}));
mock.module('./public-proxy-handler', () => ({ recordAppActivity: async () => {} }));

const { callAppTarget } = await import('./app-call');

afterAll(() => {
  internal.stop(true);
  app.stop(true);
});

test('a 3xx from the App fails the call and nothing reaches the redirect target', async () => {
  const result = await callAppTarget({
    projectId: 'p', app: 'watcher', method: 'POST', path: '/tick', payload: { probe: true }, headers: {},
    hosting: { ingress: async () => ({ url: `http://127.0.0.1:${app.port}`, headers: { 'x-pt-preview-token': 'secret' } }) } as never,
  });
  expect(result).toEqual({ ok: false, status: 307, error: 'App "watcher" answered 307 on POST /tick', retryable: false });
  expect(elsewhere).toEqual([]);
});
