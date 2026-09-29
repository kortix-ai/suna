import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realRequestContext from '../../lib/request-context';
import * as realPublicShares from '../../shared/session-public-shares';
import * as realBackend from '../backend';
import * as realPreviewHosts from '../preview-hosts';

// ── Characterization stubs ───────────────────────────────────────────────────
//
// The path form's forwarder (`forwardPublicShare`) is module-private: the only
// door is the Hono app. These stubs are the minimum needed to drive that door
// with a fake network, so the forwarding contract is pinned and a later
// extraction can prove it did not move. `mock.module` replaces a module
// WHOLESALE, so spread the real one and override only the observed collaborator;
// the `--isolate` runner gives this file its own module graph.
let shareRow: Record<string, unknown> = {};
let sandboxRecord: Record<string, unknown> = {};
let invalidateCalls: Array<[string, number]> = [];
let wakeCalls: string[] = [];

mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
mock.module('../preview-hosts', () => ({
  ...realPreviewHosts,
  // No preview domain: a document navigation stays on the path form instead of
  // redirecting to the preview origin.
  previewOriginFor: () => null,
}));
mock.module('../../shared/session-public-shares', () => ({
  ...realPublicShares,
  resolvePublicShare: async () => ({ ok: true, row: shareRow }),
  touchPublicShare: async () => {},
}));
mock.module('../backend', () => ({
  ...realBackend,
  loadSandbox: async () => sandboxRecord,
  resolveSandboxIngress: async () => ({ url: 'http://sandbox.local', headers: {} }),
  invalidatePreviewLink: (id: string, port: number) => {
    invalidateCalls.push([id, port]);
  },
  markSandboxUsed: () => {},
  wakeSandbox: async (id: string) => {
    wakeCalls.push(id);
  },
}));

const {
  PUBLIC_SHARE_SANDBOX_CSP,
  previewNavigationRedirect,
  publicResponseHeaders,
  publicShareApp,
} = await import('./public-share');

const ORIGINAL_FETCH = globalThis.fetch;
let forwardLog: Array<{ url: string; method: string; headers: Record<string, string> }> = [];

function installUpstream(status = 200, body = 'author body', headers: Record<string, string> = {}) {
  forwardLog = [];
  (globalThis as { fetch: unknown }).fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    forwardLog.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers as HeadersInit).entries()),
    });
    return new Response(body, { status, headers });
  };
}

afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
  invalidateCalls = [];
  wakeCalls = [];
});

const ACTIVE_SANDBOX = {
  sandboxId: 'sbx-1',
  externalId: 'ext-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  provider: 'daytona',
  status: 'active',
  baseUrl: '',
  serviceKey: 'svc-key',
  agentName: null,
};

function fileShare(): Record<string, unknown> {
  return {
    shareId: 'share-file-1',
    sessionId: 'sess-1',
    projectId: 'proj-1',
    externalId: 'ext-1',
    resourceType: 'file',
    filePath: '/workspace/a.html',
    mode: 'view',
    port: null,
    path: '/',
    label: 'a.html',
    allowWebsocket: false,
    sandboxStatus: 'active',
    expiresAt: null,
  };
}

function previewShare(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shareId: 'share-preview-1',
    sessionId: 'sess-1',
    projectId: 'proj-1',
    externalId: 'ext-1',
    resourceType: 'preview',
    filePath: null,
    mode: 'interactive',
    port: 3000,
    path: '/',
    label: 'app',
    allowWebsocket: true,
    sandboxStatus: 'active',
    expiresAt: null,
    ...overrides,
  };
}

const mounted = new Hono().route('/v1/p/public-share', publicShareApp);

describe('public-share path form response headers', () => {
  test('drops every upstream Set-Cookie, with or without a Domain attribute', () => {
    const upstream = new Headers();
    upstream.append('set-cookie', 'session=author; Domain=example.com; Path=/');
    upstream.append('set-cookie', 'plain=1; Path=/');
    upstream.set('content-type', 'text/html');
    const headers = publicResponseHeaders(upstream, '');
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.getSetCookie()).toEqual([]);
    expect(headers.get('content-type')).toBe('text/html');
  });

  test('runs author content in an opaque origin and keeps the author policy', () => {
    const upstream = new Headers({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    });
    const headers = publicResponseHeaders(upstream, '');
    const policies = headers.get('content-security-policy') ?? '';
    expect(policies).toContain("default-src 'self'");
    expect(policies).not.toContain('frame-ancestors');
    expect(policies).toContain(PUBLIC_SHARE_SANDBOX_CSP);
    expect(PUBLIC_SHARE_SANDBOX_CSP.startsWith('sandbox ')).toBe(true);
    expect(PUBLIC_SHARE_SANDBOX_CSP).not.toContain('allow-same-origin');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('adds the sandbox policy when upstream sends none', () => {
    const headers = publicResponseHeaders(new Headers(), 'https://viewer.example');
    expect(headers.get('content-security-policy')).toBe(PUBLIC_SHARE_SANDBOX_CSP);
    expect(headers.get('access-control-allow-credentials')).toBe('false');
  });
});

describe('public-share path form navigation redirect', () => {
  const base = {
    method: 'GET',
    fetchDest: 'document',
    previewOrigin: 'https://dev-p3000-abc.preview.example',
    path: '/docs',
    search: '?q=1',
    token: 'kps_token',
  };

  test('a document navigation goes to the preview origin with the share token', () => {
    expect(previewNavigationRedirect(base)).toBe(
      'https://dev-p3000-abc.preview.example/docs?q=1&public_share=kps_token',
    );
    expect(previewNavigationRedirect({ ...base, fetchDest: 'iframe', search: '' })).toBe(
      'https://dev-p3000-abc.preview.example/docs?public_share=kps_token',
    );
  });

  test('programmatic requests, writes, and deployments without a preview domain stay on the path form', () => {
    expect(previewNavigationRedirect({ ...base, fetchDest: 'empty' })).toBeNull();
    expect(previewNavigationRedirect({ ...base, fetchDest: undefined })).toBeNull();
    expect(previewNavigationRedirect({ ...base, method: 'POST' })).toBeNull();
    expect(previewNavigationRedirect({ ...base, previewOrigin: null })).toBeNull();
  });
});

// ── Path form forwarding (characterization) ──────────────────────────────────
//
// Pins the requests the path form emits and the responses it returns today, so
// splitting preview.ts can prove the public-share path is unchanged. The two
// share kinds take different ports and paths.
describe('public-share path form forwarding', () => {
  test('a file share forwards to the static-file port with the file path pinned', async () => {
    shareRow = fileShare();
    sandboxRecord = { ...ACTIVE_SANDBOX };
    installUpstream(200, '<html>ok</html>', {
      'content-type': 'text/html',
      'set-cookie': 'author=1; Domain=example.com; Path=/',
    });

    const res = await mounted.request('/v1/p/public-share/kps_FILE/file', {
      headers: { Origin: 'https://viewer.example' },
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>ok</html>');
    expect(forwardLog).toHaveLength(1);
    expect(forwardLog[0].url).toBe('http://sandbox.local/open?path=%2Fworkspace%2Fa.html');
    expect(forwardLog[0].method).toBe('GET');
    // Anonymous share traffic still carries the sandbox's own service key and
    // never the viewer's credential.
    expect(forwardLog[0].headers.authorization).toBe('Bearer svc-key');
    expect(forwardLog[0].headers.cookie).toBeUndefined();
    // Author-controlled content: the API-origin cookies are dropped and the
    // opaque-origin sandbox policy is appended.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-security-policy')).toContain(PUBLIC_SHARE_SANDBOX_CSP);
  });

  test('a preview share forwards to the share port and the remaining path', async () => {
    shareRow = previewShare();
    sandboxRecord = { ...ACTIVE_SANDBOX };
    installUpstream(200, 'asset', { 'content-type': 'application/javascript' });

    const res = await mounted.request('/v1/p/public-share/kps_PREV/3000/asset.js');

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset');
    expect(forwardLog).toHaveLength(1);
    expect(forwardLog[0].url).toBe('http://sandbox.local/asset.js');
    expect(forwardLog[0].headers['x-forwarded-prefix']).toBe(
      'http://localhost/v1/p/public-share/kps_PREV/3000',
    );
  });

  test('a view-only file share refuses a write before any fetch', async () => {
    shareRow = fileShare();
    sandboxRecord = { ...ACTIVE_SANDBOX };
    installUpstream();

    const res = await mounted.request('/v1/p/public-share/kps_FILE/file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'This public share is view-only' });
    expect(forwardLog).toHaveLength(0);
  });

  test('a view-mode preview share refuses a write before any fetch', async () => {
    shareRow = previewShare({ mode: 'view' });
    sandboxRecord = { ...ACTIVE_SANDBOX };
    installUpstream();

    const res = await mounted.request('/v1/p/public-share/kps_PREV/3000/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'This public share is view-only' });
    expect(forwardLog).toHaveLength(0);
  });

  test('a stopped sandbox answers 503 without dialling it', async () => {
    shareRow = previewShare();
    sandboxRecord = { ...ACTIVE_SANDBOX, status: 'stopped' };
    installUpstream();

    const res = await mounted.request('/v1/p/public-share/kps_PREV/3000/asset.js');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Sandbox is not running', status: 'stopped' });
    expect(forwardLog).toHaveLength(0);
  });

  test('a 502 retries once, dropping the cached link and waking the box', async () => {
    shareRow = previewShare();
    sandboxRecord = { ...ACTIVE_SANDBOX };
    let calls = 0;
    forwardLog = [];
    (globalThis as { fetch: unknown }).fetch = async (input: string | URL | Request) => {
      calls += 1;
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      forwardLog.push({ url, method: 'GET', headers: {} });
      return calls === 1
        ? new Response('bad gateway', { status: 502 })
        : new Response('ok', { status: 200 });
    };
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: TimerHandler) => (fn as () => void)()) as typeof setTimeout;
    try {
      const res = await mounted.request('/v1/p/public-share/kps_PREV/3000/asset.js');
      expect(res.status).toBe(200);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    expect(forwardLog).toHaveLength(2);
    expect(invalidateCalls).toEqual([['ext-1', 3000]]);
    expect(wakeCalls).toEqual(['ext-1']);
  });

});
