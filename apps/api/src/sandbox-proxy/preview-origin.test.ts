import { beforeEach, describe, expect, mock, test } from 'bun:test';

const configState: Record<string, unknown> = {
  FRONTEND_URL: 'https://dev.kortix.com',
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
let forwardedPath = '';
let forwardedQuery = '';
let shares: Record<string, unknown> = {};

mock.module('./backend', () => ({
  resolveExternalIdFromHostLabel: async (label: string) => {
    labelLookups.push(label);
    return label === 'sbx-known' ? 'sbx_KNOWN' : null;
  },
  // The WebSocket upgrade module imports these; no case here reaches them.
  invalidatePreviewLink: () => {},
  resolveSandboxIngress: async () => {
    throw new Error('not expected: no case here resolves ingress');
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
let wsUpstreamResolutions = 0;
mock.module('./routes/preview', () => ({
  resolvePreviewWsUpstream: async () => {
    wsUpstreamResolutions += 1;
    return { ok: true, url: 'wss://upstream.test/hmr', headers: {} };
  },
  forwardToSandbox: async (
    _sandboxId: string,
    _port: number,
    _access: unknown,
    _method: string,
    remainingPath: string,
    queryString: string,
  ) => {
    forwarded += 1;
    forwardedPath = remainingPath;
    forwardedQuery = queryString;
    return new Response('upstream', { status: 200 });
  },
}));
// The real module, so the blocked-port set and the view-only rule are the
// shipped ones. Only the two database reads are replaced: a share resolves by
// its exact token, or not at all, so revocation is observable.
const realPublicShares = await import('../shared/session-public-shares');
const { PUBLIC_SHARE_BLOCKED_PORTS, publicShareToken } = realPublicShares;
/** The public token of each synthetic share id below. */
const FILE_TOKEN = publicShareToken('00000000-0000-4000-a000-00000000f11e');
const PREVIEW_TOKEN = publicShareToken('00000000-0000-4000-a000-00000000b1e0');
mock.module('../shared/session-public-shares', () => ({
  ...realPublicShares,
  resolvePublicShare: async (token: string) => shares[token] ?? { ok: false, status: 404 },
  touchPublicShare: async () => {},
}));

const { handlePreviewOriginRequest } = await import('./preview-origin');
const { preparePreviewHostWsUpgrade } = await import('./ws-proxy');
const { mintPreviewSession } = await import('./preview-session');

const HOST = 'p8081-sbx-known.localhost:8008';

/** A real signed cookie for a preview, so cookie-path tests exercise the real verifier. */
function mintCookieFor(sandboxLabel: string, port: number): string {
  const token = mintPreviewSession(
    {
      kind: 'principal',
      sandboxLabel,
      sandboxId: 'sbx_KNOWN',
      port,
      userId: 'user-1',
      callerSessionId: null,
      sandboxAuthored: false,
    },
    3600,
  );
  return `__kortix_preview=${token}`;
}

function request(path: string, init: RequestInit = {}, host = HOST): [Request, URL] {
  const req = new Request(`http://127.0.0.1:8008${path}`, {
    ...init,
    headers: { host, ...(init.headers as Record<string, string> | undefined) },
  });
  return [req, new URL(`http://${host.split(':')[0]}:8008${path}`)];
}

beforeEach(() => {
  wsUpstreamResolutions = 0;
  labelLookups = [];
  principalCalls = [];
  forwarded = 0;
  forwardedPath = '';
  forwardedQuery = '';
  shares = {};
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

  test('a CORS preflight is answered before auth, but grants nothing to a stranger', async () => {
    // This test used to assert the Origin was echoed back. That WAS the bug:
    // with a SameSite=None cookie, echoing any origin plus Allow-Credentials
    // is a credentialed cross-origin read of someone's preview.
    const [req, url] = request('/api', { method: 'OPTIONS', headers: { Origin: 'https://x.test' } });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(204);
    expect(res?.headers.get('Access-Control-Allow-Origin')).toBeNull();
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

  // A fetch is told in JSON and a person navigating is shown a page; both are
  // refused before any label lookup.
  test.each([
    ['a fetch', {}, 'application/json'],
    ['a document navigation', { 'sec-fetch-dest': 'document' }, 'text/html'],
  ])('a claimed preview host without an edge signature is refused: %s', async (_label, headers, type) => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
    try {
      const [req, url] = request(
        '/learn?token=good',
        { headers: { 'x-kortix-preview-host': 'dev-p8081-sbx-known.p.kortix.com', ...headers } },
        'dev-api.kortix.com',
      );
      const res = await handlePreviewOriginRequest(req, url);
      expect(res?.status).toBe(403);
      expect(res?.headers.get('content-type')).toContain(type);
      expect(labelLookups).toEqual([]);
    } finally {
      configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    }
  });
});

describe('what a browser is shown instead of JSON', () => {
  test('a person navigating with no credential gets a page they can act on', async () => {
    const [req, url] = request('/learn', { headers: { 'sec-fetch-dest': 'document' } });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(401);
    expect(res?.headers.get('content-type')).toContain('text/html');
    const html = await res!.text();
    expect(html).toContain('Sign in to open this preview');
    // The action carries them to the web app, which brings them back here —
    // to the same address, port included.
    expect(html).toContain('https://dev.kortix.com/preview/authorize?to=');
    expect(html).toContain(encodeURIComponent('http://p8081-sbx-known.localhost:8008/learn'));
    // A sign-in flow must never try to render inside the preview frame.
    expect(html).toContain('target="_top"');
  });

  test('an iframe load is a navigation too', async () => {
    const [req, url] = request('/', { headers: { 'sec-fetch-dest': 'iframe' } });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.headers.get('content-type')).toContain('text/html');
  });

  test('a sub-resource still gets JSON — an app must never be handed HTML', async () => {
    for (const dest of ['empty', 'script', 'style', 'image']) {
      const [req, url] = request('/api/items', { headers: { 'sec-fetch-dest': dest } });
      const res = await handlePreviewOriginRequest(req, url);
      expect(res?.status).toBe(401);
      expect(res?.headers.get('content-type')).toContain('application/json');
    }
  });

  test('a preview that no longer exists says so, and offers no sign-in', async () => {
    const [req, url] = request('/?token=good', { headers: { 'sec-fetch-dest': 'document' } }, 'p8081-sbx-missing.localhost:8008');
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(404);
    const html = await res!.text();
    expect(html).toContain('no longer available');
    expect(html).not.toContain('/preview/authorize');
  });

});

describe('a public share names one thing', () => {
  test('a file share is pinned to its own file, whatever the visitor asks for', async () => {
    shares = {
      [FILE_TOKEN]: {
        ok: true,
        row: {
          shareId: '00000000-0000-4000-a000-00000000f11e',
          mode: 'view',
          resourceType: 'file',
          externalId: 'sbx_KNOWN',
          port: null,
          filePath: '/workspace/report.html',
        },
      },
    };
    const [req, url] = request(
      `/etc/passwd?public_share=${FILE_TOKEN}`,
      {},
      'p3211-sbx-known.localhost:8008',
    );
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(200);
    // Not /etc/passwd: the share's own file, through the static-web entry.
    expect(forwardedPath).toBe('/open');
    expect(forwardedQuery).toBe(`?path=${encodeURIComponent('/workspace/report.html')}`);
  });

  test('a file share is not a key to the static-web port on another port', async () => {
    shares = {
      [FILE_TOKEN]: {
        ok: true,
        row: {
          shareId: '00000000-0000-4000-a000-00000000f11e',
          mode: 'view',
          resourceType: 'file',
          externalId: 'sbx_KNOWN',
          port: null,
          filePath: '/workspace/report.html',
        },
      },
    };
    const [req, url] = request(`/?public_share=${FILE_TOKEN}`, {}, 'p8081-sbx-known.localhost:8008');
    expect((await handlePreviewOriginRequest(req, url))?.status).toBe(401);
  });

  test('a preview share is refused on a port it does not name', async () => {
    shares = {
      [PREVIEW_TOKEN]: {
        ok: true,
        row: {
          shareId: '00000000-0000-4000-a000-00000000b1e0',
          mode: 'view',
          resourceType: 'preview',
          externalId: 'sbx_KNOWN',
          port: 8081,
          filePath: null,
        },
      },
    };
    const [req, url] = request(`/?public_share=${PREVIEW_TOKEN}`, {}, 'p9999-sbx-known.localhost:8008');
    expect((await handlePreviewOriginRequest(req, url))?.status).toBe(401);
  });
});

describe('the blocked-port set applies to the share kind it was written for', () => {
  test('a preview share still cannot name an infrastructure port', async () => {
    // The shipped set, so a port added to it (opencode's standby 4097) is
    // covered here too.
    expect(PUBLIC_SHARE_BLOCKED_PORTS.has(4097)).toBe(true);
    for (const port of PUBLIC_SHARE_BLOCKED_PORTS) {
      shares = {
        [PREVIEW_TOKEN]: {
          ok: true,
          row: {
            shareId: '00000000-0000-4000-a000-00000000b1e0', mode: 'view', resourceType: 'preview',
            externalId: 'sbx_KNOWN', port, filePath: null,
          },
        },
      };
      const [req, url] = request(`/?public_share=${PREVIEW_TOKEN}`, {}, `p${port}-sbx-known.localhost:8008`);
      expect((await handlePreviewOriginRequest(req, url))?.status).toBe(401);
    }
  });
});

describe('a preview answers only the origins it should', () => {
  test('an arbitrary site gets NO credentialed CORS grant', async () => {
    // The cookie is SameSite=None, so echoing Origin back with
    // Allow-Credentials would hand any website a read of a signed-in user's
    // preview via fetch(url, {credentials:'include'}).
    const [req, url] = request('/learn', { headers: { Origin: 'https://evil.example' } });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.headers.get('access-control-allow-origin')).toBeNull();
    expect(res?.headers.get('access-control-allow-credentials')).toBeNull();
  });

  test('the Kortix web app IS allowed, and the answer varies by Origin', async () => {
    // Asserted on a response this module builds itself — the 200 path's CORS
    // headers come from clientResponseHeaders, which this file mocks away.
    const [req, url] = request('/api', {
      method: 'OPTIONS',
      headers: { Origin: 'https://dev.kortix.com' },
    });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.headers.get('access-control-allow-origin')).toBe('https://dev.kortix.com');
    expect(res?.headers.get('vary')).toContain('Origin');
  });

});

describe('the ambient cookie cannot be used for a cross-site write', () => {
  test('a cross-site POST is refused even with a valid session', async () => {
    const [req, url] = request('/submit', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', Authorization: 'Bearer good' },
    });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(403);
    expect(forwarded).toBe(0);
  });

  test('a same-origin POST is forwarded', async () => {
    const [req, url] = request('/submit', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', Authorization: 'Bearer good' },
    });
    expect((await handlePreviewOriginRequest(req, url))?.status).toBe(200);
    expect(forwarded).toBe(1);
  });

  test('a cross-site READ is still allowed — CORS governs whether it can be seen', async () => {
    const [req, url] = request('/', { headers: { 'sec-fetch-site': 'cross-site', Authorization: 'Bearer good' } });
    expect((await handlePreviewOriginRequest(req, url))?.status).toBe(200);
  });

  test('a non-browser client with no Sec-Fetch and no Origin still works', async () => {
    const [req, url] = request('/submit', { method: 'POST', headers: { Authorization: 'Bearer good' } });
    expect((await handlePreviewOriginRequest(req, url))?.status).toBe(200);
  });
});

describe('the one-shot token never lingers in the address bar', () => {
  test('a navigation that still carries ?token is bounced clean even WITH a cookie', async () => {
    // The client appends the token on every render, so a remounting iframe
    // re-lands the JWT in location.search where same-origin agent code reads it.
    const cookie = mintCookieFor('sbx-known', 8081);
    const [req, url] = request('/page?token=good&keep=1', {
      headers: { 'sec-fetch-dest': 'document', Cookie: cookie },
    });
    const res = await handlePreviewOriginRequest(req, url);
    expect(res?.status).toBe(302);
    expect(res?.headers.get('location')).toBe('/page?keep=1');
    expect(forwarded).toBe(0);
  });
});

describe('every preview request is attributed in the audit log', () => {
  // A preview page load is hundreds of requests and only the first presents a
  // token; the rest ride the signed cookie. Each one is audited by the server
  // edge, so each must be attributed here — from the cookie — and name the
  // sandbox it reached, so the row lands in the sandbox owner's log.
  const { runWithContext } = require('../lib/request-context');
  const { attachInboundAuditScope } = require('../shared/audit-scope');
  const USER = '00000000-0000-4000-a000-000000000001';

  async function scopeAfter(req: Request, url: URL) {
    return runWithContext(req.method, url.pathname, async () => {
      const scope = attachInboundAuditScope({ owner: 'edge', method: req.method });
      await handlePreviewOriginRequest(req, url);
      return scope;
    });
  }

  test('a request riding the cookie is attributed from it, without re-validating a token', async () => {
    const token = mintPreviewSession(
      {
        kind: 'principal',
        principalKind: 'user',
        sandboxLabel: 'sbx-known',
        sandboxId: 'sbx_KNOWN',
        port: 8081,
        userId: USER,
        callerSessionId: null,
        sandboxAuthored: false,
      },
      3600,
    );
    const [req, url] = request('/app.js', { headers: { cookie: `__kortix_preview=${token}` } });

    const scope = await scopeAfter(req, url);

    expect(principalCalls).toEqual([]);
    expect(scope.principal).toMatchObject({
      actorType: 'human',
      actorUserId: USER,
      authMethod: { kind: 'preview_session' },
    });
    expect(scope.annotation).toMatchObject({
      resourceType: 'sandbox_preview_origin',
      resourceId: 'sbx_KNOWN',
      metadata: { port: 8081 },
    });
  });

  test('a cookie minted before the kind existed names its principal and asserts no user', async () => {
    const [req, url] = request('/app.js', { headers: { cookie: mintCookieFor('sbx-known', 8081) } });

    const scope = await scopeAfter(req, url);

    expect(scope.principal).toMatchObject({
      authMethod: { kind: 'preview_session', principal_id: 'user-1' },
    });
    expect(scope.principal.actorUserId).toBeUndefined();
  });

  test('a refused credential on a known preview is recorded against that sandbox', async () => {
    const [req, url] = request('/learn?token=nope');

    const scope = await scopeAfter(req, url);

    expect(scope.annotation).toMatchObject({
      resourceType: 'sandbox_preview_origin',
      resourceId: 'sbx_KNOWN',
    });
  });
});

// A WebSocket handshake is a cookie-bearing request that no CORS policy
// governs: any site can open one and the browser attaches the SameSite=None
// preview cookie. And a public share is a read-only view, never a socket.
describe('a WebSocket to a preview origin', () => {
  test('the signed-in owner opening it from the preview itself is upgraded', async () => {
    const [req, url] = request('/hmr', {
      headers: { cookie: mintCookieFor('sbx-known', 8081), 'sec-fetch-site': 'same-origin' },
    });
    const res = await preparePreviewHostWsUpgrade(req, url);
    expect(res.ok).toBe(true);
    expect(wsUpstreamResolutions).toBe(1);
  });

  test('a cross-site handshake is refused, even with a valid cookie', async () => {
    const [req, url] = request('/hmr', {
      headers: { cookie: mintCookieFor('sbx-known', 8081), 'sec-fetch-site': 'cross-site' },
    });
    expect(await preparePreviewHostWsUpgrade(req, url)).toMatchObject({ ok: false, status: 403 });
    expect(wsUpstreamResolutions).toBe(0);
  });

  test('a public share never opens a socket', async () => {
    shares = {
      [PREVIEW_TOKEN]: {
        ok: true,
        row: {
          shareId: '00000000-0000-4000-a000-00000000b1e0',
          mode: 'view',
          resourceType: 'preview',
          externalId: 'sbx_KNOWN',
          port: 8081,
          filePath: null,
        },
      },
    };
    const [req, url] = request(`/hmr?public_share=${PREVIEW_TOKEN}`);
    expect(await preparePreviewHostWsUpgrade(req, url)).toMatchObject({ ok: false, status: 403 });
    expect(wsUpstreamResolutions).toBe(0);
  });
});

// A public share cookie outlives the request that set it, so both of its rules
// are re-checked on every request: a view-only link stays view-only, and a
// revoked link stops working at once.
describe('a public share on its own origin', () => {
  const shareCookie = (shareId: string) =>
    `__kortix_preview=${mintPreviewSession(
      {
        kind: 'public_share',
        sandboxLabel: 'sbx-known',
        sandboxId: 'sbx_KNOWN',
        port: 8081,
        shareId,
        mode: 'view',
        filePath: null,
      },
      900,
    )}`;
  const liveShare = (shareId: string) => ({
    [publicShareToken(shareId)]: {
      ok: true,
      row: {
        shareId,
        mode: 'view',
        resourceType: 'preview',
        externalId: 'sbx_KNOWN',
        port: 8081,
        filePath: null,
      },
    },
  });

  test('a view-only share reads, and refuses a write', async () => {
    shares = liveShare('s-view');
    const [read, readUrl] = request('/', { headers: { cookie: shareCookie('s-view') } });
    expect((await handlePreviewOriginRequest(read, readUrl))?.status).toBe(200);

    const [write, writeUrl] = request('/submit', {
      method: 'POST',
      headers: { cookie: shareCookie('s-view'), 'sec-fetch-site': 'same-origin' },
    });
    expect((await handlePreviewOriginRequest(write, writeUrl))?.status).toBe(405);
    expect(forwarded).toBe(1);
  });

  test('a revoked share stops working on the next request, cookie or not', async () => {
    shares = {};
    const [req, url] = request('/', { headers: { cookie: shareCookie('s-revoked') } });
    expect((await handlePreviewOriginRequest(req, url))?.status).toBe(410);
    expect(forwarded).toBe(0);
  });
});
