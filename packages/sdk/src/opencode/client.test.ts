import { test, expect, beforeEach, mock } from 'bun:test';
import { configureKortix } from '../platform/config';
import { dropClientForUrl, getClientForUrl, resetClient, systemReload } from './client';

let activeUrl = '';
mock.module('../state/server-store/active', () => ({
  getActiveOpenCodeUrl: () => activeUrl,
}));

beforeEach(() => {
  resetClient();
  activeUrl = '';
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'test-token' });
});

function captureRequests() {
  const calls: { url: string; auth: string | null }[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const req = input as Request;
    calls.push({ url: req.url, auth: req.headers.get('Authorization') });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

test('getClientForUrl injects the bearer token even for a URL on a completely different origin than the backend', async () => {
  const calls = captureRequests();
  const client = getClientForUrl('https://some-other-sandbox-host.example:9999/whatever');
  await client.session.abort({ sessionID: 'sess-1' });

  expect(calls.length).toBe(1);
  expect(calls[0].url).toContain('some-other-sandbox-host.example:9999');
  expect(calls[0].auth).toBe('Bearer test-token');
});

test('getClientForUrl injects the bearer token for a same-origin backend-proxied URL too', async () => {
  const calls = captureRequests();
  const client = getClientForUrl('http://backend.local/v1/p/sb-1/8000');
  await client.session.abort({ sessionID: 'sess-1' });

  expect(calls[0].auth).toBe('Bearer test-token');
});

test('getClientForUrl throws on an empty url', () => {
  expect(() => getClientForUrl('')).toThrow();
});

test('getClientForUrl caches one client per url; dropClientForUrl evicts it', () => {
  const a1 = getClientForUrl('http://x.local/p/s1/8000');
  const a2 = getClientForUrl('http://x.local/p/s1/8000');
  expect(a1).toBe(a2);

  dropClientForUrl('http://x.local/p/s1/8000');
  const a3 = getClientForUrl('http://x.local/p/s1/8000');
  expect(a3).not.toBe(a1);
});

function captureRawFetchCalls(response: () => Response) {
  const calls: { url: string; method: string; body?: string }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });
    return response();
  }) as unknown as typeof fetch;
  return calls;
}

test('systemReload POSTs {url}/kortix/services/system/reload with the mode and returns the parsed result', async () => {
  activeUrl = 'http://sbx.test';
  const calls = captureRawFetchCalls(
    () =>
      new Response(JSON.stringify({ success: true, mode: 'dispose-only', steps: ['a'], errors: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  const result = await systemReload('dispose-only');

  expect(calls[0].url).toBe('http://sbx.test/kortix/services/system/reload');
  expect(calls[0].method).toBe('POST');
  expect(JSON.parse(calls[0].body!)).toEqual({ mode: 'dispose-only' });
  expect(result).toEqual({ success: true, mode: 'dispose-only', steps: ['a'], errors: [] });
});

test('systemReload throws when the active runtime url is not ready', async () => {
  activeUrl = '';
  await expect(systemReload('full')).rejects.toThrow('Server URL not ready');
});

test('systemReload throws with the daemon error message on a non-ok response', async () => {
  activeUrl = 'http://sbx.test';
  captureRawFetchCalls(
    () => new Response(JSON.stringify({ error: 'daemon unavailable' }), { status: 503 }),
  );

  await expect(systemReload('full')).rejects.toThrow('daemon unavailable');
});
