import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const SHARE_TOKEN = 'kps_11111111111141118111111111111111';
const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const EXTERNAL_ID = 'sandbox-external-1';

let shareRow: any;
let updateCalls = 0;
let fetchUrls: string[] = [];

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => shareRow ? [shareRow] : [],
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
  buildSandboxUpstreamHeaders: async ({ serviceKey, previewToken }: any) => ({
    ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}),
    ...(previewToken ? { 'X-Daytona-Preview-Token': previewToken } : {}),
  }),
  invalidatePreviewLink: () => {},
  loadSandbox: async () => ({
    externalId: EXTERNAL_ID,
    status: 'active',
    serviceKey: 'service-key',
  }),
  markSandboxUsed: async () => {},
  resolvePreviewLink: async () => ({ url: 'https://preview.test', token: 'preview-token' }),
  wakeSandbox: async () => {},
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
  updateCalls = 0;
  fetchUrls = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    fetchUrls.push(String(url));
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
    expect(body.share.public_url).toBe(`http://p3000-${EXTERNAL_ID}.localhost:8008/?public_share=${SHARE_TOKEN}`);
    expect(body.share.resource_type).toBe('preview');
  });

  test('rejects ports outside the share allow-list', async () => {
    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/8000/`);
    expect(res.status).toBe(403);
  });

  test('allows normal app methods for preview shares', async () => {
    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/api`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
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

  test('proxies file share asset requests under the same public prefix', async () => {
    shareRow = {
      ...shareRow,
      resourceType: 'file',
      label: 'index.html',
      port: null,
      filePath: '/workspace/app/index.html',
    };

    const res = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/file/abs/workspace/app/style.css`);
    expect(res.status).toBe(200);
    expect(fetchUrls.at(-1)).toBe('https://preview.test/abs/workspace/app/style.css');
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
