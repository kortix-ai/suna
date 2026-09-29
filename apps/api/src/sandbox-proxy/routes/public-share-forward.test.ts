import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
// The path-form public-share forwarder, pinned before and after it is collapsed
// onto `forwardToSandbox`.
//
// - Characterization: a programmatic client on the path form gets the upstream's
//   own status and body, with the path-form response contract applied — every
//   upstream Set-Cookie dropped, the author's CSP kept, the sandbox policy
//   appended. Written against the hand-rolled forwarder BEFORE the collapse, so
//   they pass unchanged after it.
// - Posture: the collapsed forwarder retries like the preview-origin public-share
//   path (forwardToSandbox with `{ kind: 'public_share' }`) — one retry on a
//   connection failure wakes the box and re-resolves the cached ingress link;
//   a 502 response invalidates the link and retries without a wake.
//
// The heavier ../backend, ownership and env-sync dependencies are inert stubs.
// `mock.module` is process-global; the `--isolate` runner gives this file its
// own module graph.
import { Hono } from 'hono';
import * as realRequestContext from '../../lib/request-context';

const configState: Record<string, unknown> = {
  FRONTEND_URL: '',
  KORTIX_PREVIEW_BASE_DOMAIN: undefined,
};
mock.module('../../config', () => ({
  config: configState,
  // Named exports the loaded module graph reads (providers, snapshot hashes).
  SANDBOX_VERSION: 'test',
  KORTIX_MARKUP: 1.2,
  MORPH_MANAGED_MODELS_DEFAULT: '',
  getToolCost: () => 0,
  parseMorphManagedModels: () => [],
}));

const ACTIVE_RECORD = {
  status: 'active',
  serviceKey: 'svc-key',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  externalId: 'ext-1',
  agentName: 'default',
  provider: 'daytona',
};

let fetchCalls = 0;
let wakeCalls = 0;
let invalidateCalls = 0;
let ingressResolves = 0;
let touchCalls = 0;
let usedCalls = 0;

mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
mock.module('../backend', () => ({
  // Every export the loaded module graph reads — `mock.module` replaces the
  // module wholesale, so a shorter list is a link error from a stranger.
  resolveExternalIdFromHostLabel: async () => null,
  resolveServiceKey: async () => 'svc-key',
  invalidateSandbox: () => {},
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: (_record: unknown, request: { port: number }) => ({
    effectivePort: request.port,
  }),
  resolveSandboxIngress: async () => {
    ingressResolves += 1;
    return { url: 'http://sandbox.local', headers: {} };
  },
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {
    invalidateCalls += 1;
  },
  markSandboxUsed: () => {
    usedCalls += 1;
  },
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {
    wakeCalls += 1;
  },
}));

// The real module, so the blocked-port set and the static-file port are the
// shipped ones. Only the two database reads are replaced.
const realPublicShares = await import('../../shared/session-public-shares');
const { publicShareToken } = realPublicShares;
const PREVIEW_TOKEN = publicShareToken('00000000-0000-4000-a000-00000000f10e');
const FILE_TOKEN = publicShareToken('00000000-0000-4000-a000-00000000f11e');
const VIEW_TOKEN = publicShareToken('00000000-0000-4000-a000-00000000f12d');

let shares: Record<string, unknown> = {};
mock.module('../../shared/session-public-shares', () => ({
  ...realPublicShares,
  resolvePublicShare: async (token: string) => shares[token] ?? { ok: false as const, status: 404 },
  touchPublicShare: async () => {
    touchCalls += 1;
  },
}));

const { publicShareApp } = await import('./public-share');

// The routes live under their real mount point: the handlers read the full
// request pathname (`/public-share/<token>/<port>`) to split the remaining path.
const app = new Hono().route('/v1/p/public-share', publicShareApp);
const PATH = '/v1/p/public-share';

const previewShare = {
  shareId: 'share-preview-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  resourceType: 'preview',
  label: 'app',
  port: 3000,
  path: '/docs',
  filePath: null,
  mode: 'edit',
  allowWebsocket: true,
  sandboxStatus: 'active',
  expiresAt: null,
  externalId: 'ext-1',
};
const fileShare = {
  ...previewShare,
  shareId: 'share-file-1',
  resourceType: 'file',
  port: null,
  path: null,
  filePath: 'reports/q3.pdf',
};
const viewOnlyShare = { ...previewShare, shareId: 'share-view-1', mode: 'view' };

const ORIGINAL_FETCH = globalThis.fetch;

/** A fetch that answers from a queue, in order, and counts its calls. */
let fetchLog: string[] = [];
function queueFetch(...responses: Array<Response | Error>) {
  fetchCalls = 0;
  fetchLog = [];
  (globalThis as { fetch: unknown }).fetch = async (input: string | URL | Request) => {
    fetchCalls += 1;
    fetchLog.push(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than queued');
    if (next instanceof Error) throw next;
    return next;
  };
}

beforeEach(() => {
  wakeCalls = 0;
  invalidateCalls = 0;
  ingressResolves = 0;
  touchCalls = 0;
  usedCalls = 0;
  fetchCalls = 0;
  fetchLog = [];
  shares = {
    [PREVIEW_TOKEN]: { ok: true, row: previewShare },
    [FILE_TOKEN]: { ok: true, row: fileShare },
    [VIEW_TOKEN]: { ok: true, row: viewOnlyShare },
  };
  // Any forward a gate was supposed to stop fails loudly here instead of
  // dialling the network.
  (globalThis as { fetch: unknown }).fetch = async () => {
    throw new Error('no upstream fetch was expected in this case');
  };
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('the path-form public-share forward (characterization)', () => {
  test('a preview share forwards to its port and answers with the upstream status and body', async () => {
    queueFetch(
      new Response('<html>author app</html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': 'session=author; Path=/' },
      }),
    );
    const res = await app.request(`${PATH}/${PREVIEW_TOKEN}/3000/docs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>author app</html>');
    expect(fetchLog[0]).toBe('http://sandbox.local/docs');
    // The path-form response contract: no upstream cookie reaches the API origin.
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.headers.get('content-security-policy')).toContain('sandbox ');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(usedCalls).toBe(1);
    expect(touchCalls).toBe(1);
  });

  test('a file share is pinned to /open on the static-file port with the file path', async () => {
    queueFetch(
      new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    const res = await app.request(`${PATH}/${FILE_TOKEN}/file`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.4');
    expect(fetchLog[0]).toBe(
      `http://sandbox.local/open?path=${encodeURIComponent('reports/q3.pdf')}`,
    );
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(usedCalls).toBe(1);
    expect(touchCalls).toBe(1);
  });

  test('a file share answers 405 for a write method, before any forward', async () => {
    const res = await app.request(`${PATH}/${FILE_TOKEN}/file`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'This public share is view-only' });
    expect(fetchCalls).toBe(0);
  });

  test('a view-mode preview share answers 405 for a write method, before any forward', async () => {
    const res = await app.request(`${PATH}/${VIEW_TOKEN}/3000/docs`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'This public share is view-only' });
    expect(fetchCalls).toBe(0);
  });

  test('a port the share does not name answers 403, before any forward', async () => {
    const res = await app.request(`${PATH}/${PREVIEW_TOKEN}/9999/docs`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not authorized for this port' });
    expect(fetchCalls).toBe(0);
  });

  test('a file share answers 403 for any path other than its own file entry', async () => {
    const res = await app.request(`${PATH}/${FILE_TOKEN}/file/other`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not authorized for this file path' });
    expect(fetchCalls).toBe(0);
  });
});

describe('the collapsed forwarder retry and wake posture (the shared forwarder)', () => {
  test('one retry on a connection failure wakes the box and re-resolves the ingress link', async () => {
    queueFetch(
      new Error('ECONNREFUSED'),
      new Response('recovered', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const res = await app.request(`${PATH}/${PREVIEW_TOKEN}/3000/docs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('recovered');
    expect(fetchCalls).toBe(2);
    // The wake the preview-origin public-share path performs: exactly one, and
    // the cached ingress link is dropped so the retry resolves a fresh address.
    expect(wakeCalls).toBe(1);
    expect(invalidateCalls).toBe(1);
    expect(ingressResolves).toBe(2);
    expect(touchCalls).toBe(1);
  });

  test('a 502 response invalidates the link and retries without a wake', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }), new Response('ok', { status: 200 }));
    const res = await app.request(`${PATH}/${PREVIEW_TOKEN}/3000/docs`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(fetchCalls).toBe(2);
    expect(wakeCalls).toBe(0);
    expect(invalidateCalls).toBe(1);
    expect(touchCalls).toBe(1);
  });

  test('a file share gets the same posture on the static-file port', async () => {
    queueFetch(new Error('ECONNREFUSED'), new Response('recovered', { status: 200 }));
    const res = await app.request(`${PATH}/${FILE_TOKEN}/file`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('recovered');
    expect(fetchCalls).toBe(2);
    expect(wakeCalls).toBe(1);
    expect(invalidateCalls).toBe(1);
    expect(ingressResolves).toBe(2);
    expect(touchCalls).toBe(1);
  });
});
