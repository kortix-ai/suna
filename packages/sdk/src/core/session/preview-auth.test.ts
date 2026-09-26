import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let token: string | null = 'jwt-token';

mock.module('../http/auth', () => ({
  getAuthToken: async () => token,
}));

// The deployment's advertised preview template (`GET /v1/p/config`). Only an
// origin built from it may receive the one-shot `?token`.
let advertisedTemplate: string | null = 'https://dev-p{port}-{sandbox}.p.kortix.com';
let configLoads = 0;
mock.module('./preview-config', () => ({
  hasPreviewConfig: () => false,
  cachedPreviewUrlTemplate: () => advertisedTemplate,
  loadPreviewUrlTemplate: async () => {
    configLoads += 1;
    return advertisedTemplate;
  },
  knownPreviewUrlTemplates: () => (advertisedTemplate ? [advertisedTemplate] : []),
  resetPreviewConfigCache: () => {},
}));

const { configureKortix } = await import('../http/config');
const { authorizePreviewUrl, ensurePreviewSessionCookie } = await import('./preview-auth');

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
  requests = [];
  advertisedTemplate = 'https://dev-p{port}-{sandbox}.p.kortix.com';
  configLoads = 0;
  // The path-proxy URLs below are served by this backend.
  configureKortix({ backendUrl: 'http://localhost:8008/v1', getToken: async () => token });
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

  test('never sends the bearer to a path-proxy URL on an origin nobody configured', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    expect(await ensurePreviewSessionCookie('https://collector.example/v1/p/sbx1/3211/open')).toBe(false);
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

describe('authorizePreviewUrl — the URL to actually open', () => {
  test('a preview ORIGIN gets the credential in the URL, because a cookie cannot be set for it', async () => {
    // The /v1/p/ cookie is host-scoped to the API; it never reaches
    // dev-p8081-….p.kortix.com. Opening the bare URL lands on the sign-in gate.
    stubFetch(() => new Response(null, { status: 204 }));
    const url = await authorizePreviewUrl('https://dev-p3211-sbx-a.p.kortix.com/open?path=/workspace/a.md');
    expect(url).toBe(
      'https://dev-p3211-sbx-a.p.kortix.com/open?path=%2Fworkspace%2Fa.md&token=jwt-token',
    );
    // No cookie POST is attempted — there is no endpoint that could set one.
    expect(requests).toHaveLength(0);
  });

  test('the local origin form is treated the same way against a local backend', async () => {
    advertisedTemplate = null;
    const url = await authorizePreviewUrl('http://p3211-sbx-a.localhost:8008/open?path=/a.md');
    expect(url).toContain('token=jwt-token');
  });

  test('a host that only looks like a preview origin never receives the credential', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    for (const target of [
      // A Kortix App host whose slug starts with `p<digits>-`.
      'https://dev-p3000-x-0123456789abcdef.apps.kortix.com/',
      // A foreign host with the preview label shape.
      'https://p80-anything.attacker.example/',
      // The local form on a port the local backend does not serve.
      'http://p3211-sbx-a.localhost:9999/open',
    ]) {
      expect(await authorizePreviewUrl(target)).toBe(target);
    }
    expect(requests).toHaveLength(0);
  });

  test('a deployment that advertises no preview origin trusts none', async () => {
    advertisedTemplate = null;
    const target = 'https://dev-p3211-sbx-a.p.kortix.com/open';
    expect(await authorizePreviewUrl(target)).toBe(target);
  });

  test('the template is asked for before the first decision', async () => {
    await authorizePreviewUrl('https://dev-p3211-sbx-a.p.kortix.com/open');
    expect(configLoads).toBe(1);
  });

  test('a path-proxy URL still mints the cookie and is returned unchanged', async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    const target = 'http://localhost:8008/v1/p/sbx1/3211/open?path=/workspace/a.md';
    const url = await authorizePreviewUrl(target);
    expect(url).toBe(target);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://localhost:8008/v1/p/auth');
  });

  test('with no token it returns the URL unchanged rather than a broken one', async () => {
    token = null;
    const target = 'https://dev-p3211-sbx-a.p.kortix.com/open';
    expect(await authorizePreviewUrl(target)).toBe(target);
  });

  test('a non-preview URL is left alone', async () => {
    const target = 'https://example.com/thing';
    expect(await authorizePreviewUrl(target)).toBe(target);
    expect(requests).toHaveLength(0);
  });
});
