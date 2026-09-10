import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as backend from '../sandbox-proxy/backend';
import * as ownership from '../shared/preview-ownership';

let origin = '';
let invalidations = 0;
let requests = 0;
let replyStatus = 200;
const servers: ReturnType<typeof Bun.serve>[] = [];
mock.module('../sandbox-proxy/backend', () => ({
  ...backend,
  resolveServiceKey: async () => 'service-key',
  resolveSandboxIngress: async () => ({ url: origin, headers: { 'x-preview-token': invalidations ? 'fresh' : 'expired' } }),
  invalidateSandbox: () => { invalidations++; },
}));
mock.module('../shared/preview-ownership', () => ({ ...ownership, resolvePreviewUserContext: async () => null }));
const { listSandboxOpencodeSessions } = await import('./opencode-mapping');

beforeEach(() => { invalidations = 0; requests = 0; replyStatus = 200; });
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function serve() {
  const server = Bun.serve({ port: 0, fetch(request) {
    requests++;
    expect(request.headers.get('authorization')).toBe('Bearer service-key');
    if (request.headers.get('x-preview-token') !== 'fresh') return new Response('expired preview token', { status: 401 });
    return Response.json(replyStatus === 200 ? [{ id: 'ses_root' }] : { error: 'denied' }, { status: replyStatus });
  } });
  servers.push(server);
  origin = `http://127.0.0.1:${server.port}`;
}

test('a rotated provider preview token is refreshed once before listing the same conversation', async () => {
  serve();
  expect(await listSandboxOpencodeSessions('worker-1', 'user-1')).toEqual({ ok: true, sessions: [{ id: 'ses_root' }] });
  expect(invalidations).toBe(1);
  expect(requests).toBe(2);
});

test('a fresh rejected credential remains closed after one refresh', async () => {
  replyStatus = 401;
  serve();
  expect(await listSandboxOpencodeSessions('worker-1', 'user-1')).toEqual({ ok: false, reason: 'unreachable' });
  expect(invalidations).toBe(1);
  expect(requests).toBe(2);
});

test('a starting runtime remains not ready after its preview token refresh', async () => {
  replyStatus = 503;
  serve();
  expect(await listSandboxOpencodeSessions('worker-1', 'user-1')).toEqual({ ok: false, reason: 'not_ready' });
  expect(invalidations).toBe(1);
  expect(requests).toBe(2);
});
