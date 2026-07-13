import { test, expect, beforeEach, mock } from 'bun:test';
const { platformFetch } = await import('./shared');
const { configureKortix } = await import('../../http/config');
const { ApiError, BillingError } = await import('../../http/api/errors');

beforeEach(() => {
  delete process.env.BACKEND_URL;
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok' });
});

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function mockFetchNonJson(status: number, text: string) {
  globalThis.fetch = (async () => new Response(text, { status, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
}

test('returns the parsed body on success', async () => {
  mockFetch(200, { success: true, data: { ok: true } });
  const result = await platformFetch<{ ok: boolean }>('/whoami');
  expect(result).toEqual({ success: true, data: { ok: true } });
});

test('throws a typed ApiError (with status + details) on a non-ok JSON response', async () => {
  mockFetch(500, { error: 'boom', code: 'INTERNAL' });
  await expect(platformFetch('/whoami')).rejects.toBeInstanceOf(ApiError);
  await expect(platformFetch('/whoami')).rejects.toMatchObject({ status: 500, code: 'INTERNAL', message: 'boom' });
});

test('a 402 response is converted into a BillingError', async () => {
  mockFetch(402, { message: 'insufficient credits' });
  await expect(platformFetch('/whoami')).rejects.toBeInstanceOf(BillingError);
});

test('guards res.json() defensively — a non-JSON error body still throws a typed ApiError, not a raw SyntaxError', async () => {
  mockFetchNonJson(502, '<html>Bad Gateway</html>');
  const err = await platformFetch('/whoami').catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(502);
});
