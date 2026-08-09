import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureKortix } from '../http/config';

let token: string | null = 'jwt-token';

import { ensurePreviewSessionCookie } from './preview-auth';

const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; init: RequestInit }> = [];

function stubFetch(handler: () => Response | Promise<Response>) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    return handler();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  token = 'jwt-token';
  configureKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => token });
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ensurePreviewSessionCookie', () => {
  test('POSTs the bearer token to the derived /p/auth endpoint with credentials', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    const ok = await ensurePreviewSessionCookie(
      'http://localhost:8008/v1/p/sbx1/3211/open?path=/workspace/a.md',
    );

    expect(ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://localhost:8008/v1/p/auth');
    expect(requests[0].init.method).toBe('POST');
    expect(requests[0].init.credentials).toBe('include');
    expect((requests[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer jwt-token',
    );
  });

  test('returns false without issuing a request for a non-preview URL', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    expect(await ensurePreviewSessionCookie('https://example.com/a.md')).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test('returns false without issuing a request when no token is available', async () => {
    token = null;
    stubFetch(() => new Response(null, { status: 204 }));

    expect(await ensurePreviewSessionCookie('http://localhost:8008/v1/p/sbx1/3211/open')).toBe(
      false,
    );
    expect(requests).toHaveLength(0);
  });

  test('reports failure rather than throwing when the exchange rejects', async () => {
    stubFetch(() => {
      throw new Error('network down');
    });

    expect(await ensurePreviewSessionCookie('http://localhost:8008/v1/p/sbx1/3211/open')).toBe(
      false,
    );
  });

  test('reports failure when the endpoint answers non-2xx', async () => {
    stubFetch(() => new Response(null, { status: 401 }));

    expect(await ensurePreviewSessionCookie('http://localhost:8008/v1/p/sbx1/3211/open')).toBe(
      false,
    );
  });
});
