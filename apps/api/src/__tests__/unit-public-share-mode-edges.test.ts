import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
// The real forwarder: only the sandbox lookup and the upstream hop are fake, so
// this suite exercises the actual decision a share's request meets on the edge.
import * as realBackend from '../sandbox-proxy/backend';

const SHARE_TOKEN = 'kps_22222222222242228222222222222222';
const SHARE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const ACCOUNT_ID = '55555555-5555-4555-8555-555555555555';
const EXTERNAL_ID = 'sandbox-external-2';

let shareRow: any;
// Every upstream hop the real forwarder made, so a refused write proves it
// never reached the sandbox app.
let upstreamCalls: { method: string; url: string }[] = [];

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => (shareRow ? [shareRow] : []),
            }),
          }),
        }),
        innerJoin: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

mock.module('../sandbox-proxy/backend', () => ({
  ...realBackend,
  buildSandboxUpstreamHeaders: async ({ providerHeaders }: any) => providerHeaders,
  invalidatePreviewLink: () => {},
  loadSandbox: async () => ({ externalId: EXTERNAL_ID, status: 'active', serviceKey: 'service-key' }),
  markSandboxErrored: async () => {},
  markSandboxUsed: async () => {},
  resolveSandboxIngress: async () => ({
    url: 'https://preview.test',
    headers: { 'x-provider-traffic-token': 'preview-token' },
    effectivePort: 3000,
  }),
  routeSandboxIngress: (_record: any, request: any) => ({ effectivePort: request.port }),
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
  upstreamCalls = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    upstreamCalls.push({ method: init?.method ?? 'GET', url: String(url) });
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

describe('KRTX-4406: a preview share mode the path edge has not heard of stays read-only', () => {
  // The regression: the path edge compared `mode` to the literal 'view', so any
  // other non-interactive value was writable here while the preview origin
  // refused it. Both edges now ask the same shared allowlist.
  test('refuses a write for every mode that is not interactive, and never reaches the app', async () => {
    for (const mode of ['view', 'readonly', 'read-only', 'VIEW', '', 'viewer']) {
      shareRow = { ...shareRow, mode };
      upstreamCalls = [];

      const write = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/api/todos`, {
        method: 'POST',
        body: '{"title":"x"}',
      });
      expect({ mode, status: write.status }).toEqual({ mode, status: 405 });
      expect({ mode, body: await write.json() }).toEqual({
        mode,
        body: { error: 'This public share is view-only' },
      });
      expect({ mode, hops: upstreamCalls }).toEqual({ mode, hops: [] });
    }
  });

  test('forwards a write for an interactive share — the gate is not refusing everything', async () => {
    shareRow = { ...shareRow, mode: 'interactive', allowWebsocket: true };

    const write = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/api/todos`, {
      method: 'POST',
      body: '{"title":"x"}',
    });
    expect(write.status).toBe(200);
    expect(await write.text()).toBe('ok');
    expect(upstreamCalls.map((c) => c.method)).toEqual(['POST']);
    expect(upstreamCalls[0].url).toContain('/api/todos');
  });

  test('reads pass for every mode', async () => {
    for (const mode of ['view', 'readonly', 'VIEW', '', 'interactive']) {
      shareRow = { ...shareRow, mode };
      upstreamCalls = [];

      const read = await app().request(`/v1/p/public-share/${SHARE_TOKEN}/3000/`);
      expect({ mode, status: read.status }).toEqual({ mode, status: 200 });
      expect({ mode, hops: upstreamCalls.length }).toEqual({ mode, hops: 1 });
    }
  });
});
