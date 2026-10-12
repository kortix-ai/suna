import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
// The real module namespace, so the mock below only overrides the calls this
// suite stubs and still carries every export the shared forwarder imports.
import * as realBackend from '../sandbox-proxy/backend';

const SHARE_TOKEN = 'kps_11111111111141118111111111111111';
const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const EXTERNAL_ID = 'sandbox-external-1';

let shareRow: any;
let personalBindingRow: { connectionId: string } | null;
let updateCalls = 0;
let fetchUrls: string[] = [];
let fetchInits: RequestInit[] = [];
let ingressResolves = 0;
let invalidations = 0;
let wakes = 0;

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => shareRow ? [shareRow] : [],
            }),
          }),
        }),
        innerJoin: () => ({
          where: () => ({
            limit: async () => personalBindingRow ? [personalBindingRow] : [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          updateCalls += 1;
        },
      }),
    }),
  },
}));

mock.module('../sandbox-proxy/backend', () => ({
  ...realBackend,
  buildSandboxUpstreamHeaders: async ({ serviceKey, providerHeaders }: any) => ({
    ...providerHeaders,
    ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}),
  }),
  invalidatePreviewLink: () => {
    invalidations += 1;
  },
  loadSandbox: async () => ({
    externalId: EXTERNAL_ID,
    status: 'active',
    serviceKey: 'service-key',
  }),
  markSandboxErrored: async () => {},
  markSandboxUsed: async () => {},
  resolveSandboxIngress: async () => {
    ingressResolves += 1;
    return {
      url: 'https://preview.test',
      headers: { 'e2b-traffic-access-token': 'preview-token' },
      effectivePort: 3000,
    };
  },
  routeSandboxIngress: (_record: any, request: any) => ({ effectivePort: request.port }),
  wakeSandbox: async () => {
    wakes += 1;
  },
}));

const originalFetch = globalThis.fetch;

beforeEach(() => {
  shareRow = {
    shareId: SHARE_ID,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    resourceType: 'preview',
    label: 'App preview',
    port: 3000,
    path: '/',
    filePath: null,
    mode: 'view',
    allowWebsocket: false,
    expiresAt: null,
    revokedAt: null,
    externalId: EXTERNAL_ID,
    sandboxStatus: 'active',
  };
  personalBindingRow = null;
  updateCalls = 0;
  fetchUrls = [];
  fetchInits = [];
  ingressResolves = 0;
  invalidations = 0;
  wakes = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    fetchUrls.push(String(url));
    fetchInits.push(init ?? {});
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { publicShareApp } = await import('../sandbox-proxy/routes/public-share');

function app() {
  const hono = new Hono();
  hono.route('/v1/p/public-share', publicShareApp);
  return hono;
}

describe('public session preview shares', () => {
  test('returns public metadata without authenticated preview auth', async () => {
    const res = await app().request(new Request(`http://localhost:8008/v1/p/public-share/${SHARE_TOKEN}`));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.share.proxy_path).toBe(`/v1/p/public-share/${SHARE_TOKEN}/3000/`);
    expect(body.share.public_url).toBe(`http://localhost:8008/v1/p/public-share/${SHARE_TOKEN}/3000/`);
    expect(body.share.resource_type).toBe('preview');
  });

  test('rejects a legacy public link when the session now has a personal connector binding', async () => {
    personalBindingRow = { connectionId: '55555555-5555-4555-8555-555555555555' };

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}`);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Sessions using a personal connection cannot be shared publicly',
    });
  });

  // 5173 is not a blocked port, so the share's own port is the only reason
  // this is refused. The blocked set is its own row below.
  test('a preview share is pinned to its own port', async () => {
    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/5173/`);
    expect(res.status).toBe(403);
  });

  test('keeps view-mode preview shares read-only', async () => {
    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/api`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'This public share is view-only' });
  });

  test('proxies allowed GET requests and records use', async () => {
    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(updateCalls).toBe(1);
  });

  test('proxies file shares through the static file server', async () => {
    shareRow = {
      ...shareRow,
      resourceType: 'file',
      label: 'index.html',
      port: null,
      filePath: '/workspace/app/index.html',
    };

    const meta = await app().request(`/v1/p/public-share/${SHARE_TOKEN}`);
    expect(meta.status).toBe(200);
    const body = await meta.json() as any;
    expect(body.share.proxy_path).toBe(`/v1/p/public-share/${SHARE_TOKEN}/file`);
    expect(body.share.public_url).toBeNull();

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/file`);
    expect(res.status).toBe(200);
    expect(fetchUrls.at(-1)).toBe('https://preview.test/open?path=%2Fworkspace%2Fapp%2Findex.html');
  });

  test('rejects file share subpaths instead of exposing the static file server', async () => {
    shareRow = {
      ...shareRow,
      resourceType: 'file',
      label: 'index.html',
      port: null,
      filePath: '/workspace/app/index.html',
    };

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/file/abs/workspace/app/style.css`);
    expect(res.status).toBe(403);
    expect(fetchUrls.length).toBe(0);
  });

  test('does not let caller query params override the shared file path', async () => {
    shareRow = {
      ...shareRow,
      resourceType: 'file',
      label: 'index.html',
      port: null,
      filePath: '/workspace/app/index.html',
    };

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/file/open?path=/workspace/secret.env`);
    expect(res.status).toBe(200);
    expect(fetchUrls.at(-1)).toBe('https://preview.test/open?path=%2Fworkspace%2Fapp%2Findex.html');
  });

  test('rejects static file server port as a preview share target', async () => {
    shareRow = {
      ...shareRow,
      resourceType: 'preview',
      port: 3211,
    };

    const meta = await app().request(`/v1/p/public-share/${SHARE_TOKEN}`);
    expect(meta.status).toBe(403);

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3211/`);
    expect(res.status).toBe(403);
  });

  test('keeps file shares read-only', async () => {
    shareRow = {
      ...shareRow,
      resourceType: 'file',
      label: 'index.html',
      port: null,
      filePath: '/workspace/app/index.html',
    };

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/file`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(405);
  });

});

describe('path-form public shares delegate to the shared sandbox forwarder', () => {
  test('a preview share and a file share return the same status and body', async () => {
    const preview = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe('ok');
    expect(updateCalls).toBe(1);

    shareRow = {
      ...shareRow,
      resourceType: 'file',
      label: 'index.html',
      port: null,
      filePath: '/workspace/app/index.html',
    };
    const file = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/file`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('ok');
  });

  test('a 502 invalidates the link and re-resolves the ingress once before it succeeds', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('bad gateway', { status: 502 })
        : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(calls).toBe(2);
    expect(invalidations).toBe(1);
    expect(ingressResolves).toBe(2);
  });

  test('a dead-signal 400 wakes the sandbox and re-resolves the ingress', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('no IP address found', { status: 400 })
        : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/`);
    expect(res.status).toBe(200);
    expect(wakes).toBe(1);
    expect(ingressResolves).toBe(2);
  });
});

describe('public transcript shares on the proxy edge', () => {
  beforeEach(() => {
    shareRow = {
      ...shareRow,
      resourceType: 'transcript',
      label: 'Conversation',
      port: null,
      filePath: null,
      externalId: null,
      sandboxStatus: null,
    };
  });

  test('a transcript share resolves without a sandbox and names its public messages route', async () => {
    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.share.resource_type).toBe('transcript');
    expect(body.share.proxy_path).toBe(`/v1/public/session-shares/${SHARE_TOKEN}/messages`);
    expect(body.share.public_url.endsWith(`/share/session/${SHARE_TOKEN}`)).toBe(true);
  });

  test('a transcript share opens no port and no file', async () => {
    shareRow = { ...shareRow, externalId: EXTERNAL_ID, sandboxStatus: 'active' };
    for (const path of ['3000/', 'file', 'file/open']) {
      const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/${path}`);
      expect(res.status).toBe(403);
    }
    expect(fetchUrls.length).toBe(0);
  });
});

describe('public shares of a deleted session', () => {
  test('a tombstoned session ends every link to it → 410', async () => {
    for (const resourceType of ['preview', 'transcript']) {
      shareRow = { ...shareRow, resourceType, sessionMetadata: { deletedAt: '2026-09-26T00:00:00.000Z' } };
      const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}`);
      expect(res.status).toBe(410);
    }
  });
});

// The public origin is derived from the client-facing request, not from the
// hop that reached the API. A chained proxy appends to `x-forwarded-proto`
// ("https, http"); the scheme is its FIRST value, never the raw header value.
// The no-header URL-scheme fallback is pinned by the first test of this file.
describe('public share origin across chained proxies', () => {
  test('a single x-forwarded-proto value becomes the scheme', async () => {
    const res = await app().request(`http://localhost:8008/v1/p/public-share/${SHARE_TOKEN}`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.share.public_url).toBe(`https://localhost:8008/v1/p/public-share/${SHARE_TOKEN}/3000/`);
  });

  test('a plain-http value keeps the http scheme', async () => {
    const res = await app().request(`http://localhost:8008/v1/p/public-share/${SHARE_TOKEN}`, {
      headers: { 'x-forwarded-proto': 'http' },
    });
    const body = await res.json() as any;
    expect(body.share.public_url).toBe(`http://localhost:8008/v1/p/public-share/${SHARE_TOKEN}/3000/`);
  });

  test('a chained proxy that appended to x-forwarded-proto gets the first value', async () => {
    const res = await app().request(`http://localhost:8008/v1/p/public-share/${SHARE_TOKEN}`, {
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    const body = await res.json() as any;
    expect(body.share.public_url).toBe(`https://localhost:8008/v1/p/public-share/${SHARE_TOKEN}/3000/`);
  });

  test('the X-Forwarded-Prefix handed to the sandbox app carries the first proto value too', async () => {
    const res = await app().request(`http://localhost:8008/v1/p/public-share/${SHARE_TOKEN}/3000/`, {
      headers: { 'x-forwarded-proto': 'https, http' },
    });
    expect(res.status).toBe(200);
    const headers = fetchInits.at(-1)?.headers as Headers | undefined;
    expect(headers?.get('x-forwarded-prefix')).toBe(
      `https://localhost:8008/v1/p/public-share/${SHARE_TOKEN}/3000`,
    );
  });
});
