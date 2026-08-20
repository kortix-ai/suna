import { beforeEach, describe, expect, mock, test } from 'bun:test';

const configState: Record<string, unknown> = {
  KORTIX_URL: 'https://dev-api.kortix.com',
  INTERNAL_KORTIX_ENV: 'dev',
  PORT: 8008,
  API_KEY_SECRET: 'test-secret-value-32-chars-long!!',
  KORTIX_PREVIEW_BASE_DOMAIN: undefined,
};
mock.module('../config', () => ({ config: configState }));

let labelLookups: string[] = [];
let principalCalls: Array<string | null | undefined> = [];
let forwarded = 0;

mock.module('./backend', () => ({
  resolveExternalIdFromHostLabel: async (label: string) => {
    labelLookups.push(label);
    return label === 'sbx-known' ? 'sbx_KNOWN' : null;
  },
}));
mock.module('./preview-auth', () => ({
  extractPreviewToken: (req: Request, url: URL) =>
    req.headers.get('Authorization')?.replace('Bearer ', '') || url.searchParams.get('token'),
  authenticatePreviewPrincipalDetailed: async (token: string | null) => {
    principalCalls.push(token);
    return token === 'good' ? { userId: 'user-1', sessionId: null } : null;
  },
}));
mock.module('./routes/preview', () => ({
  forwardToSandbox: async () => {
    forwarded += 1;
    return new Response('upstream', { status: 200 });
  },
}));
mock.module('../shared/session-public-shares', () => ({
  PUBLIC_SHARE_BLOCKED_PORTS: new Set<number>(),
  resolvePublicShare: async () => ({ ok: false }),
  touchPublicShare: async () => {},
}));

const { handlePreviewOriginRequest } = await import('./preview-origin');

const HOST = 'p8081-sbx-known.localhost:8008';

function request(path: string, init: RequestInit = {}, host = HOST): [Request, URL] {
  const req = new Request(`http://127.0.0.1:8008${path}`, {
    ...init,
    headers: { host, ...(init.headers as Record<string, string> | undefined) },
  });
  return [req, new URL(`http://${host.split(':')[0]}:8008${path}`)];
}

beforeEach(() => {
  labelLookups = [];
  principalCalls = [];
  forwarded = 0;
});

describe('preview origin auth gate', () => {
  test('a request with no credential is refused before any database work', async () => {
    const res = await handlePreviewOriginRequest(...request('/learn'));
    expect(res?.status).toBe(401);
    // The label→id lookup cannot use an index, so an anonymous caller must not
    // be able to spend one per made-up hostname.
    expect(labelLookups).toEqual([]);
    expect(principalCalls).toEqual([]);
  });

  test('a hostname that is not a preview falls through to normal API routing', async () => {
    expect(await handlePreviewOriginRequest(...request('/v1/health', {}, 'dev-api.kortix.com'))).toBeNull();
  });

  test('an unknown preview with a credential answers 404, not 401', async () => {
    const [req, url] = request('/learn?token=good', {}, 'p8081-sbx-missing.localhost:8008');
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(404);
    expect(labelLookups).toEqual(['sbx-missing']);
  });

  test('a valid token mints a cookie and forwards', async () => {
    const [req, url] = request('/learn', { headers: { Authorization: 'Bearer good' } });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(200);
    expect(forwarded).toBe(1);
    const cookies = res!.headers.getSetCookie();
    expect(cookies.length).toBe(2);
    expect(cookies.every((c) => c.includes('Secure'))).toBe(true);
    expect(cookies.some((c) => c.includes('Partitioned'))).toBe(true);
  });

  test('a token in the URL is exchanged for a cookie and bounced off the address bar', async () => {
    const [req, url] = request('/learn?token=good&keep=1', {
      headers: { 'sec-fetch-dest': 'document' },
    });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(302);
    // The credential is gone; everything else the app was asked for survives.
    expect(res?.headers.get('location')).toBe('/learn?keep=1');
    expect(res!.headers.getSetCookie().length).toBe(2);
    expect(forwarded).toBe(0);
  });

  test('a sub-resource with a token is served directly, not redirected', async () => {
    const [req, url] = request('/app.js?token=good', { headers: { 'sec-fetch-dest': 'script' } });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(200);
    expect(forwarded).toBe(1);
  });

  test('an invalid token is refused', async () => {
    const [req, url] = request('/learn?token=nope');
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(401);
    expect(principalCalls).toEqual(['nope']);
  });

  test('a CORS preflight is answered before auth', async () => {
    const [req, url] = request('/api', { method: 'OPTIONS', headers: { Origin: 'https://x.test' } });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(204);
    expect(res?.headers.get('Access-Control-Allow-Origin')).toBe('https://x.test');
    expect(principalCalls).toEqual([]);
  });

  test('self-host direct-edge mode serves the real Host with no signature', async () => {
    // No Cloudflare Worker fronts a self-host: the operator's own reverse proxy
    // (the bundled Caddy) is the trust boundary and passes the real Host
    // through untouched.
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.acme.com';
    process.env.KORTIX_PREVIEW_ALLOW_DIRECT_EDGE = 'true';
    try {
      const [req, url] = request(
        '/learn?token=good',
        {},
        `dev-p8081-${'sbx-known'}.p.acme.com`,
      );
      const res = await handlePreviewOriginRequest(req, url);
      expect(res?.status).toBe(200);
      expect(forwarded).toBe(1);
    } finally {
      delete process.env.KORTIX_PREVIEW_ALLOW_DIRECT_EDGE;
      configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    }
  });

  test('direct-edge mode ignores a claimed host header — only the real Host counts', async () => {
    // Otherwise anyone reaching a self-host API directly could name any preview
    // by setting a header, which is the whole reason the header is signed on
    // Kortix Cloud.
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.acme.com';
    process.env.KORTIX_PREVIEW_ALLOW_DIRECT_EDGE = 'true';
    try {
      const [req, url] = request(
        '/learn?token=good',
        { headers: { 'x-kortix-preview-host': 'dev-p8081-sbx-known.p.acme.com' } },
        'api.acme.com',
      );
      expect(await handlePreviewOriginRequest(req, url)).toBeNull();
      expect(forwarded).toBe(0);
    } finally {
      delete process.env.KORTIX_PREVIEW_ALLOW_DIRECT_EDGE;
      configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    }
  });

  test('a claimed preview host without an edge signature is refused', async () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
    const [req, url] = request(
      '/learn?token=good',
      { headers: { 'x-kortix-preview-host': 'dev-p8081-sbx-known.p.kortix.com' } },
      'dev-api.kortix.com',
    );
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(403);
    expect(labelLookups).toEqual([]);
    configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
  });
});
