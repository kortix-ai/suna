import { test, expect, beforeEach } from 'bun:test';
import { configureKortix } from '../platform/config';
import { dropClientForUrl, getClientForUrl, resetClient } from './client';

beforeEach(() => {
  resetClient();
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
