import { test, expect, beforeEach, mock } from 'bun:test';
import { configureKortix } from '../http/config';
import { setCurrentRuntime } from '../session/current-runtime';

// This file used to fake `getActiveRuntimeUrl` entirely via
// `mock.module('../session/server-store/active', ...)`. That's a process-wide,
// permanent-for-the-sweep override (see the hermetic-pattern comment below) —
// and since it replaced the WHOLE module with only one export, any other file
// that imports `state/server-store/active` for real (e.g. a direct test of
// that module) would see every other export silently gutted to `undefined`.
// Driving the same "active runtime url" control through the REAL state seam
// instead (`setCurrentRuntime` — the same primitive `getActiveRuntimeUrl`
// itself reads — plus `configureKortix({ billingEnabled: true })` so "no
// active session" resolves to '', matching the old default) gives this file
// identical control with no mock at all — nothing left to collide with.

// This file must be hermetic against process-wide `mock.module('../http/auth', ...)`
// registrations made by OTHER test files (files/client.test.ts, opencode/env.test.ts,
// opencode/triggers.test.ts, session/session.test.ts all mock the same shared module
// path). Bun's `mock.module` is process-wide and permanent for the whole `bun test`
// sweep — whichever file's registration is resident when THIS file's own dynamic
// `import('./client')` below runs wins for every call made through that import. So this
// file registers its OWN mock for '../platform/auth' — with a controllable token +
// authenticatedFetch implementation this file fully owns — instead of depending on the
// real module's behavior, and imports './client' via `await import(...)` (matching the
// pattern already used by files/client.test.ts / opencode/env.test.ts /
// opencode/triggers.test.ts) so it resolves against ITS OWN mock regardless of load order.
let authToken: string | null = 'test-token';
mock.module('../http/auth', () => ({
  getAuthToken: async () => authToken,
  getAuthTokenWithRetry: async () => authToken,
  authenticatedFetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    if (input instanceof Request) {
      return fetch(new Request(input, { headers }));
    }
    return fetch(input, { ...init, headers });
  },
  invalidateTokenCache: () => {},
  setCachedAuthToken: () => {},
  setBootstrapAuthToken: () => {},
  getSupabaseAccessToken: async () => authToken,
  getSupabaseAccessTokenWithRetry: async () => authToken,
}));

const {
  dropClientForUrl,
  dropPublicClientForUrl,
  getClientForUrl,
  getPublicClientForUrl,
  resetClient,
  resetPublicClient,
  systemReload,
} = await import('./client');

beforeEach(() => {
  resetClient();
  resetPublicClient();
  setCurrentRuntime(null);
  authToken = 'test-token';
  // billingEnabled: true so `getActiveRuntimeUrl()` resolves to '' with no
  // active session (matching this file's old `activeUrl = ''` default),
  // instead of the self-hosted local-dev fallback sandbox url.
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => authToken ?? null, billingEnabled: true });
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

// ── getPublicClientForUrl — the UNAUTHENTICATED client factory, for routes the
// backend deliberately makes reachable by a logged-out visitor (e.g. the
// public-share proxy). Regression: the old `getClient()` path always injects
// the platform bearer token via `authenticatedFetch`, which synthesizes a 401
// with no network call at all when there's no token — breaking anonymous
// access entirely (see ShareViewer.tsx). ──────────────────────────────────

test('getPublicClientForUrl never sends an Authorization header, even with a token configured', async () => {
  const calls = captureRequests();
  const client = getPublicClientForUrl('http://backend.local/v1/p/public-share/tok123/3000');
  await client.session.abort({ sessionID: 'sess-1' });

  expect(calls.length).toBe(1);
  expect(calls[0].auth).toBeNull();
});

test('getPublicClientForUrl works without configureKortix ever having been called (no token-provider requirement)', async () => {
  // A real anonymous visitor's tab may never call configureKortix() with a
  // getToken — getClientForUrl would throw a missing auth token error
  // provider configured' here; the public client must not.
  const calls = captureRequests();
  const client = getPublicClientForUrl('http://backend.local/v1/p/public-share/tok123/3000');
  await expect(client.session.abort({ sessionID: 'sess-1' })).resolves.toBeDefined();
  expect(calls.length).toBe(1);
});

test('getPublicClientForUrl throws on an empty url', () => {
  expect(() => getPublicClientForUrl('')).toThrow();
});

test('getPublicClientForUrl caches one client per url; dropPublicClientForUrl evicts it', () => {
  const a1 = getPublicClientForUrl('http://backend.local/v1/p/public-share/tok123/3000');
  const a2 = getPublicClientForUrl('http://backend.local/v1/p/public-share/tok123/3000');
  expect(a1).toBe(a2);

  dropPublicClientForUrl('http://backend.local/v1/p/public-share/tok123/3000');
  const a3 = getPublicClientForUrl('http://backend.local/v1/p/public-share/tok123/3000');
  expect(a3).not.toBe(a1);
});

test('getPublicClientForUrl and getClientForUrl keep separate caches for the same url', () => {
  const url = 'http://backend.local/v1/p/public-share/tok123/3000';
  const pub = getPublicClientForUrl(url);
  const auth = getClientForUrl(url);
  expect(pub).not.toBe(auth);
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
  setCurrentRuntime('http://sbx.test', 'active-sbx');
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
  setCurrentRuntime(null);
  await expect(systemReload('full')).rejects.toThrow('Server URL not ready');
});

test('systemReload throws with the daemon error message on a non-ok response', async () => {
  setCurrentRuntime('http://sbx.test', 'active-sbx');
  captureRawFetchCalls(
    () => new Response(JSON.stringify({ error: 'daemon unavailable' }), { status: 503 }),
  );

  await expect(systemReload('full')).rejects.toThrow('daemon unavailable');
});
