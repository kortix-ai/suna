// Characterization tests for the preview forwarder and the WebSocket upstream
// resolver — phase 1 of the `split-preview-ts-forwarder` spec (KRTX-327).
//
// `forwardToSandbox` (the 1104-line pipeline) and `resolvePreviewWsUpstream`
// are about to be decomposed across phases 2-4. Nothing in those phases may
// change a status code, a body shape, a hop attribution, or the upstream auth
// header set. This file pins each of those observables at the existing seams
// so a later phase that drifts fails here, not in production.
//
// Covered here because no existing suite reaches it:
//   - forwardToSandbox refusal branches (404, ownership 403, /kortix/env 404,
//     base-reset 403, session-visibility 403, share-token agent-switch 403)
//   - the stopped-box wake policy at the forwarder (503 control_plane page vs
//     JSON, auto-resume on user intent)
//   - the retry/wake machinery (502/503 invalidate+retry, connection-refused
//     wake-once, Daytona stopped-box 400 wake-once, the dead-signal erroring)
//   - redirect rewriting and CORS/cookie handling for originMode vs path form
//   - resolvePreviewWsUpstream end to end (it is only ever mocked elsewhere)
//   - public-share delegation: {kind:'public_share'} vs the path form
//
// The heavier ../backend, ownership and env-sync dependencies are inert stubs.
// `mock.module` is process-global; the `--isolate` runner gives this file its
// own module graph.
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import * as realRequestContext from '../../lib/request-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';
import * as realPublicShares from '../../shared/session-public-shares';

const ACTIVE_RECORD = {
  sandboxId: 'sbx-uuid-1',
  externalId: 'ext-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  provider: 'daytona',
  status: 'active',
  serviceKey: 'svc-key',
  baseUrl: 'https://provider.test',
  agentName: 'default',
};

// ── knobs the tests flip ──
let currentRecord: Record<string, unknown> = { ...ACTIVE_RECORD };
let previewAccessAllowed = true;
let sessionAccessAllowed = true;
let authorizeCalls = 0;
let ingress: Record<string, unknown> = { url: 'http://sandbox.local', headers: {} };
let upstreamAuthHeaders: Record<string, string> = {};
let shareRow: Record<string, unknown> | null = null;
const counts = {
  wakeSandbox: 0,
  invalidatePreviewLink: 0,
  markSandboxUsed: 0,
  markSandboxErrored: 0,
  resumeStopped: 0,
};

mock.module('../../config', () => ({
  config: { FRONTEND_URL: 'http://localhost:3000' },
}));
mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next. Overriding only what
// this file needs keeps new exports working by default.
mock.module('../../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => previewAccessAllowed,
  canAccessSandboxSession: async () => sessionAccessAllowed,
}));
mock.module('../../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_AGENT_READ: 'project.agent.read' },
  authorize: async () => {
    authorizeCalls += 1;
    return { allowed: true, reason: 'role' };
  },
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));
mock.module('../../projects/lib/session-token-grant', () => ({
  agentLaunchableInProject: async () => true,
  remintGrantForAgentSwitch: async () => ({ action: 'skip' }),
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/lib/turn-start-convergence', () => ({
  convergeBeforeTurnStart: async () => ({ decision: 'skipped', outcome: null, ms: 0 }),
  scheduleAssetConvergence: () => {},
  convergeModelCatalogForTurnStart: async () => ({ decision: 'skipped' }),
}));
mock.module('../../projects/session-activity', () => ({
  recordSessionActivity: async () => {},
}));
const realTurnLifecycle = await import('../../projects/sandbox-turn-lifecycle');
mock.module('../../projects/sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  beginSandboxTurn: async () => 'granted',
  acceptSandboxTurn: async () => true,
  abandonSandboxTurn: async () => true,
}));
mock.module('../../projects/session-open', () => ({
  resumeStoppedSandboxByExternalId: async (externalId: string) => {
    counts.resumeStopped += 1;
    return Boolean(externalId);
  },
}));
mock.module('../../shared/session-public-shares', () => ({
  ...realPublicShares,
  resolvePublicShare: async () =>
    shareRow ? { ok: true as const, row: { ...shareRow } } : { ok: false as const, status: 404, error: 'not found' },
  touchPublicShare: async () => {},
}));
const realDeadline = await import('../../projects/sandbox-deadline');
mock.module('../../projects/sandbox-deadline', () => ({
  ...realDeadline,
  // The preview-use extend is a real DB write; these cases assert status/body
  // shapes, not deadline grants — the writer stays silent here.
  extendSandboxDeadline: async () => {},
}));
// The pass-through matches the Daytona provider (`routeIngress` answers the
// addressed port unchanged), which is the primary provider this suite models.
mock.module('../backend', () => ({
  loadSandbox: async () => (currentRecord === null ? null : { ...currentRecord }),
  routeSandboxIngress: (_record: unknown, request: { port: number }) => ({
    effectivePort: request.port,
  }),
  resolveSandboxIngress: async () => ({ ...ingress }),
  buildSandboxUpstreamHeaders: async () => ({ ...upstreamAuthHeaders }),
  invalidatePreviewLink: () => {
    counts.invalidatePreviewLink += 1;
  },
  markSandboxUsed: () => {
    counts.markSandboxUsed += 1;
  },
  markSandboxErrored: async () => {
    counts.markSandboxErrored += 1;
  },
  wakeSandbox: async () => {
    counts.wakeSandbox += 1;
  },
}));

const { forwardToSandbox, resolvePreviewWsUpstream } = await import('./preview');
const { publicShareApp } = await import('./public-share');
const { KORTIX_USER_CONTEXT_HEADER } = await import('../../shared/kortix-user-context');
const { __resetPromptDedupe } = await import('../prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;

const principal = {
  kind: 'principal' as const,
  userId: 'u1',
  callerSessionId: null,
  boundCredentialSessionId: null,
  sandboxAuthored: false,
};
const shareAccess = { kind: 'public_share' } as const;

const jsonHeaders = (extra?: Record<string, string>) =>
  new Headers({ 'content-type': 'application/json', ...(extra ?? {}) });
const bodyOf = (obj: unknown) =>
  new TextEncoder().encode(JSON.stringify(obj)).buffer as ArrayBuffer;

/** A fetch that answers from a queue, in order, and counts its calls. */
let fetchCalls = 0;
function queueFetch(...responses: Array<Response | Error>) {
  fetchCalls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    fetchCalls += 1;
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than queued');
    if (next instanceof Error) throw next;
    return next;
  };
}

/** A fetch that records the last request and answers from a queue. */
let lastFetch: { url: string; headers: Headers } | null = null;
function recordingFetch(...responses: Array<Response | Error>) {
  fetchCalls = 0;
  lastFetch = null;
  (globalThis as { fetch: unknown }).fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetchCalls += 1;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    lastFetch = { url, headers: new Headers(init?.headers) };
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than queued');
    if (next instanceof Error) throw next;
    return next;
  };
}

const refused = () => {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:3000');
  (err as { code?: string }).code = 'ECONNREFUSED';
  return err;
};

function forward(overrides?: {
  access?: typeof principal | typeof shareAccess;
  method?: string;
  path?: string;
  port?: number;
  query?: string;
  headers?: Headers;
  body?: ArrayBuffer;
  origin?: string;
  redirectPrefix?: string;
  publicOrigin?: string;
  originMode?: boolean;
}) {
  return forwardToSandbox(
    'ext-1',
    overrides?.port ?? 3000,
    overrides?.access ?? principal,
    overrides?.method ?? 'GET',
    overrides?.path ?? '/',
    overrides?.query ?? '',
    overrides?.headers ?? new Headers(),
    overrides?.body,
    overrides?.origin ?? '',
    overrides?.redirectPrefix,
    overrides?.publicOrigin,
    overrides?.originMode === undefined ? {} : { originMode: overrides.originMode },
  );
}

beforeEach(() => {
  __resetPromptDedupe();
  currentRecord = { ...ACTIVE_RECORD };
  previewAccessAllowed = true;
  sessionAccessAllowed = true;
  authorizeCalls = 0;
  ingress = { url: 'http://sandbox.local', headers: {} };
  upstreamAuthHeaders = {};
  shareRow = null;
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) counts[key] = 0;
  fetchCalls = 0;
  lastFetch = null;
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

// ── refusal branches ─────────────────────────────────────────────────────────

describe('forwardToSandbox refusal branches', () => {
  test('an unknown sandbox is a 404 JSON body with the CORS pair', async () => {
    currentRecord = null as unknown as Record<string, unknown>;
    const res = await forward({ origin: 'http://localhost:3000' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'sandbox not found' });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  test('a caller who does not own the sandbox gets a 403 HTTPException before any dial', async () => {
    previewAccessAllowed = false;
    queueFetch(new Response('should never be fetched'));
    let thrown: unknown = null;
    try {
      await forward();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    const httpError = thrown as HTTPException;
    expect(httpError.status).toBe(403);
    expect(httpError.message).toBe('Not authorized to access this sandbox, userId: u1, sandboxId: ext-1');
    expect(fetchCalls).toBe(0);
  });

  test('POST /kortix/env on the daemon port is a 404, not a write into the box', async () => {
    const res = await forward({ method: 'POST', path: '/kortix/env', port: 8000, body: bodyOf({ FOO: 'bar' }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(fetchCalls).toBe(0);
  });

  test('an encoded spelling of /kortix/env or the base reset is refused like the plain one', async () => {
    const env = await forward({ method: 'POST', path: '/kortix/%65nv', port: 8000, body: bodyOf({ FOO: 'bar' }) });
    expect(env.status).toBe(404);
    const reset = await forward({ path: '/kortix/r%65fresh', query: '?base=1', port: 8000 });
    expect(reset.status).toBe(403);
    expect(fetchCalls).toBe(0);
  });

  test('an ambiguous path on the daemon port is a 400; an app port keeps its escapes', async () => {
    for (const path of ['/kortix/a%2Fb', '/kortix/%zz', '/kortix/%2e%2e/env']) {
      const res = await forward({ path, port: 8000 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid request path', code: 'INVALID_PATH' });
    }
    expect(fetchCalls).toBe(0);
    recordingFetch(new Response('app', { status: 200 }));
    const app = await forward({ path: '/a%2Fb', port: 3000 });
    expect(app.status).toBe(200);
    expect(String(lastFetch?.url)).toContain('/a%2Fb');
  });

  test('the destructive base reset is refused with its code; a plain refresh is not', async () => {
    const refused = await forward({ path: '/kortix/refresh', query: '?base=1', port: 8000 });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'base reset is not available through the sandbox proxy',
      code: 'BASE_RESET_FORBIDDEN',
    });
    expect(fetchCalls).toBe(0);

    queueFetch(new Response('refreshed', { status: 200 }));
    const plain = await forward({ path: '/kortix/refresh', query: '?mode=restart', port: 8000 });
    expect(plain.status).toBe(200);
    expect(fetchCalls).toBe(1);
  });

  test('a member without session visibility is refused on the daemon port, not on an app port', async () => {
    sessionAccessAllowed = false;
    let thrown: unknown = null;
    try {
      await forward({ port: 8000, path: '/session' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    expect((thrown as HTTPException).status).toBe(403);
    expect((thrown as HTTPException).message).toBe('Not authorized to access this session');
    expect(fetchCalls).toBe(0);

    // An ordinary app port carries no conversation, so the visibility gate does not apply.
    queueFetch(new Response('app', { status: 200 }));
    const appPort = await forward({ port: 3000, path: '/' });
    expect(appPort.status).toBe(200);
    expect(fetchCalls).toBe(1);
  });

  test('a share-token caller cannot switch agents — refused with no principal to authorize', async () => {
    queueFetch(new Response('should never be fetched'));
    const res = await forward({
      access: shareAccess,
      method: 'POST',
      path: '/session/sess-1/message',
      port: 8000,
      body: bodyOf({ agent: 'nda-turnaround', parts: [{ type: 'text', text: 'hi' }] }),
      headers: jsonHeaders(),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "You don't have permission to run the agent 'nda-turnaround'.",
      code: 'AGENT_NOT_AUTHORIZED',
      requested_agent: 'nda-turnaround',
    });
    expect(authorizeCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});

// ── the stopped-box policy at the forwarder ──────────────────────────────────

describe('forwardToSandbox on a stopped sandbox', () => {
  test('a passive read is 503 from the control plane, with no dial and no wake', async () => {
    currentRecord = { ...ACTIVE_RECORD, status: 'stopped' };
    queueFetch(new Response('should never be fetched'));
    const res = await forward({ port: 8000, path: '/session' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'sandbox not ready (status: stopped)',
      port: 8000,
      status: 503,
      hop: 'control_plane',
      upstream_status: null,
      code: 'sandbox_not_ready',
      retry: true,
    });
    expect(res.headers.get('x-kortix-proxy-hop')).toBe('control_plane');
    expect(res.headers.get('x-kortix-upstream-status')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchCalls).toBe(0);
    expect(counts.wakeSandbox).toBe(0);
    expect(counts.resumeStopped).toBe(0);
  });

  test('a browser navigation gets the 200 starting page, not the 5xx', async () => {
    currentRecord = { ...ACTIVE_RECORD, status: 'stopped' };
    queueFetch(new Response('should never be fetched'));
    const res = await forward({
      port: 3000,
      path: '/',
      headers: new Headers({ accept: 'text/html' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-kortix-preview-state')).toBe('starting');
    expect(res.headers.get('x-kortix-proxy-hop')).toBe('control_plane');
    expect(await res.text()).toContain('<!doctype html>');
  });

  test('an explicit session mutation claims the resume, answers 503 while still stopped, then forwards once active', async () => {
    currentRecord = { ...ACTIVE_RECORD, status: 'stopped' };
    const args = {
      method: 'POST',
      path: '/session/sess-1/message',
      port: 8000,
      body: bodyOf({ parts: [{ type: 'text', text: 'hi' }] }),
      headers: jsonHeaders(),
    } as const;
    queueFetch(new Response('should stay queued until the box answers'));
    const during = await forward(args);
    expect(during.status).toBe(503);
    expect(counts.resumeStopped).toBe(1);
    expect(counts.wakeSandbox).toBe(0);
    expect(fetchCalls).toBe(0);

    currentRecord = { ...ACTIVE_RECORD, status: 'active' };
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const after = await forward(args);
    expect(after.status).toBe(200);
    expect(fetchCalls).toBe(1);
  });

  test('the box itself can never resume its own sandbox', async () => {
    currentRecord = { ...ACTIVE_RECORD, status: 'stopped' };
    queueFetch(new Response('should never be fetched'));
    const res = await forward({
      method: 'POST',
      path: '/session/sess-1/message',
      port: 8000,
      body: bodyOf({ parts: [{ type: 'text', text: 'hi' }] }),
      headers: jsonHeaders(),
      access: { ...principal, sandboxAuthored: true },
    });
    expect(res.status).toBe(503);
    expect(counts.resumeStopped).toBe(0);
    expect(counts.wakeSandbox).toBe(0);
  });
});

// ── the retry / wake machinery ───────────────────────────────────────────────

describe('forwardToSandbox retry and wake', () => {
  // The retry sleeps (250 ms / 1 s / 3 s) are real, so the four-attempt cases
  // need ~4.5 s — above Bun's 5 s default per-test timeout on a direct run.
  // The explicit 8 s keeps them honest and fast instead of loosening the
  // batch runner's 15 s floor.
  test('a GET 502 invalidates the ingress link and retries to a 200, never waking the box', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }), new Response('ok', { status: 200 }));
    const res = await forward({ port: 3000, path: '/' });
    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(2);
    expect(counts.invalidatePreviewLink).toBe(1);
    expect(counts.wakeSandbox).toBe(0);
  });

  test('retries exhausted: a browser gets the unreachable page, not the 5xx', async () => {
    const fiftyTwo = () => new Response('bad gateway', { status: 502 });
    // MAX_RETRIES = 3 → four attempts.
    queueFetch(fiftyTwo(), fiftyTwo(), fiftyTwo(), fiftyTwo());
    const browser = await forward({ port: 3000, path: '/', headers: new Headers({ accept: 'text/html' }) });
    expect(browser.status).toBe(200);
    expect(browser.headers.get('x-kortix-preview-state')).toBe('unreachable');
    expect(browser.headers.get('x-kortix-proxy-hop')).toBe('upstream_port');
    expect(browser.headers.get('x-kortix-upstream-status')).toBe('502');
    expect(fetchCalls).toBe(4);
    expect(counts.wakeSandbox).toBe(0);
  }, 8_000);

  test('retries exhausted: a machine client gets the bare upstream 5xx', async () => {
    const fiftyTwo = () => new Response('bad gateway', { status: 502 });
    queueFetch(fiftyTwo(), fiftyTwo(), fiftyTwo(), fiftyTwo());
    const machine = await forward({ port: 3000, path: '/' });
    expect(machine.status).toBe(502);
    expect(await machine.text()).toBe('bad gateway');
    expect(fetchCalls).toBe(4);
    expect(counts.wakeSandbox).toBe(0);
  }, 8_000);

  test('a connection-refused GET wakes the sandbox once, then gives up with a 502 on the daemon hop', async () => {
    queueFetch(refused(), refused(), refused(), refused());
    // The give-up must leave its per-stage timeline behind: the stage deltas
    // (load-sandbox / ingress) are what makes a latency spike on this path
    // attributable from the log line alone. The timeline ships through the api
    // logger (`logger.info` — console.log does not reach Better Stack), so the
    // capture spies that seam.
    const { logger } = await import('../../lib/logger');
    const originalInfo = logger.info;
    const logs: unknown[][] = [];
    logger.info = ((...args: unknown[]) => {
      logs.push(args);
      originalInfo(...(args as Parameters<typeof originalInfo>));
    }) as typeof logger.info;
    let res: Response;
    try {
      res = await forward({ port: 8000, path: '/session' });
    } finally {
      logger.info = originalInfo;
    }
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'sandbox upstream unreachable',
      port: 8000,
      status: 502,
      hop: 'daemon',
      upstream_status: null,
    });
    expect(res.headers.get('x-kortix-proxy-hop')).toBe('daemon');
    expect(res.headers.get('x-kortix-upstream-status')).toBeNull();
    expect(fetchCalls).toBe(4);
    expect(counts.wakeSandbox).toBe(1);
    expect(counts.invalidatePreviewLink).toBe(3);
    // A transient unreachable must never error a health-green row.
    expect(counts.markSandboxErrored).toBe(0);
    const timeline = logs.find(
      (args) => typeof args[0] === 'string' && args[0].includes('[provision-timeline] proxy'),
    );
    expect(timeline?.[0]).toContain('total=');
    expect(timeline?.[0]).toContain('ingress=');
    expect(timeline?.[1]).toEqual({ path: '/session', port: 8000, hop: 'daemon' });
  }, 8_000);

  test('a Daytona stopped-box 400 wakes once and retries; the last attempt passes the 400 through', async () => {
    const down = () => new Response('failed to get runner info: no IP address found', { status: 400 });
    queueFetch(down(), down(), down(), down());
    const res = await forward({ port: 3000, path: '/' });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('failed to get runner info: no IP address found');
    expect(fetchCalls).toBe(4);
    expect(counts.wakeSandbox).toBe(1);
    expect(counts.invalidatePreviewLink).toBe(3);
    // The 400 was returned before the give-up path, so the row was never errored.
    expect(counts.markSandboxErrored).toBe(0);
  }, 8_000);

  test('a dead signal followed by an unreachable network errors the row before the 502', async () => {
    queueFetch(
      new Response('failed to get runner info: no IP address found', { status: 400 }),
      refused(),
      refused(),
      refused(),
    );
    const res = await forward({ port: 3000, path: '/' });
    expect(res.status).toBe(502);
    expect(fetchCalls).toBe(4);
    expect(counts.wakeSandbox).toBe(1);
    expect(counts.markSandboxErrored).toBe(1);
  }, 8_000);
});

// ── provider-edge and signed-context auth failures ───────────────────────────

describe('forwardToSandbox authentication failures', () => {
  test('a Daytona ingress 401 on a GET drops the cached link once and succeeds on the retry', async () => {
    const stale = () =>
      new Response(
        JSON.stringify({ statusCode: 401, code: 'UNAUTHORIZED', message: 'unauthorized: authentication failed: stale token' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    queueFetch(stale(), new Response('ok', { status: 200 }));
    const res = await forward({ port: 3000, path: '/' });
    expect(res.status).toBe(200);
    expect(fetchCalls).toBe(2);
    expect(counts.invalidatePreviewLink).toBe(1);
  });

  test('a Daytona ingress 401 on a write is never replayed — 503 with its code', async () => {
    queueFetch(
      new Response(
        JSON.stringify({ statusCode: 401, code: 'UNAUTHORIZED', message: 'unauthorized: authentication failed: stale token' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    const res = await forward({ method: 'POST', path: '/upload', port: 3000, body: bodyOf({ a: 1 }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'sandbox provider authentication unavailable',
      code: 'sandbox_provider_auth_unavailable',
      retry: true,
    });
    expect(fetchCalls).toBe(1);
  });

  test('an upstream 401 that the provider did not sign is a 502 signed-context rejection', async () => {
    currentRecord = { ...ACTIVE_RECORD, provider: 'e2b' };
    queueFetch(new Response('unauthorized', { status: 401 }));
    const res = await forward({ port: 3000, path: '/' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'sandbox proxy authentication rejected' });
    expect(fetchCalls).toBe(1);
  });

  test('an opencode not-ready 503 passes through and releases the dedupe claim', async () => {
    const args = {
      method: 'POST',
      path: '/session/sess-1/message',
      port: 8000,
      body: bodyOf({ parts: [{ type: 'text', text: 'hi' }] }),
      headers: jsonHeaders({ 'idempotency-key': 'nr-1' }),
    } as const;
    queueFetch(new Response('opencode not ready', { status: 503 }));
    const first = await forward(args);
    expect(first.status).toBe(503);
    expect(await first.text()).toBe('opencode not ready');
    expect(counts.markSandboxUsed).toBe(1);

    // The claim was released: the client's retry delivers instead of deduping.
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const retry = await forward(args);
    expect(retry.status).toBe(200);
    expect(await retry.json()).not.toEqual({ status: 'duplicate', deduplicated: true });
  });

  // pi (and OpenCode's boot steps) refuse with another text, a W6 daemon adds
  // `code: runtime_not_ready`, and every daemon names its boot phase in
  // `X-Kortix-Boot-Phase`. Each must release the claim on its own.
  for (const [name, body, headers] of [
    ['the daemon text of a pi runtime', '{"error":"sandbox runtime not ready","phase":"starting"}', {}],
    ['the runtime_not_ready code', '{"code":"runtime_not_ready","error":"starting","phase":"starting"}', {}],
    ['only the boot-phase header', '{"error":"starting"}', { 'X-Kortix-Boot-Phase': 'opencode-starting' }],
  ] as const) {
    test(`a not-ready 503 with ${name} passes through and releases the dedupe claim`, async () => {
      const args = {
        method: 'POST',
        path: '/session/sess-1/message',
        port: 8000,
        body: bodyOf({ parts: [{ type: 'text', text: 'hi' }] }),
        headers: jsonHeaders({ 'idempotency-key': `nr-${name}` }),
      } as const;
      queueFetch(new Response(body, { status: 503, headers }));
      const first = await forward(args);
      expect(first.status).toBe(503);
      expect(await first.text()).toBe(body);

      queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
      const retry = await forward(args);
      expect(retry.status).toBe(200);
      expect(await retry.json()).not.toEqual({ status: 'duplicate', deduplicated: true });
    });
  }

  test('a not-ready 503 on a GET passthrough carries the daemon attribution', async () => {
    // The hydrate reads (/lsp/diagnostics, /permission, /question, /vcs/diff, …)
    // land on this branch when the runtime restarts behind a live box. The
    // passthrough must say WHICH hop answered (proxy-hop.ts): `daemon`, plus
    // the status the daemon returned, so the request log can tell the designed
    // boot-window answer from a failure (request-log-level.ts).
    const args = {
      method: 'GET',
      path: '/lsp/diagnostics',
      port: 8000,
      origin: 'http://localhost:3000',
    } as const;
    queueFetch(
      new Response('{"error":"starting"}', {
        status: 503,
        headers: { 'X-Kortix-Boot-Phase': 'opencode-starting' },
      }),
    );
    const res = await forward(args);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"starting"}');
    expect(res.headers.get('X-Kortix-Proxy-Hop')).toBe('daemon');
    expect(res.headers.get('X-Kortix-Upstream-Status')).toBe('503');
    // The web app and the API are different origins: without the expose the
    // browser hides both headers from JS and the probe is back to guessing.
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe(
      'X-Kortix-Proxy-Hop, X-Kortix-Upstream-Status',
    );
    expect(fetchCalls).toBe(1);
  });

  test('a not-ready-shaped 503 from an APP port is attributed to that port, not the daemon', async () => {
    // The not-ready match is header/body text (KRTX-397 self-review): a user
    // app on an ordinary port could answer with the same shape. The hop must
    // be the PORT's hop (portFailureHop), so the GET line stays logged
    // (request-log-level.ts suppresses only the `daemon` hop) and the probe
    // counts it — an app cannot borrow the daemon's designed answer.
    const args = {
      method: 'GET',
      path: '/healthz',
      port: 3000,
      origin: 'http://localhost:3000',
    } as const;
    queueFetch(
      new Response('starting', {
        status: 503,
        headers: { 'X-Kortix-Boot-Phase': 'opencode-starting' },
      }),
    );
    const res = await forward(args);
    expect(res.status).toBe(503);
    expect(res.headers.get('X-Kortix-Proxy-Hop')).toBe('upstream_port');
    expect(res.headers.get('X-Kortix-Upstream-Status')).toBe('503');
    expect(fetchCalls).toBe(1);
  });

  test('a 503 that only mentions "not ready" in an unrelated body keeps the claim', async () => {
    const args = {
      method: 'POST',
      path: '/session/sess-1/message',
      port: 8000,
      body: bodyOf({ parts: [{ type: 'text', text: 'hi' }] }),
      headers: jsonHeaders({ 'idempotency-key': 'nr-ambiguous' }),
    } as const;
    queueFetch(new Response('{"error":"gateway not ready","code":"upstream_unavailable"}', { status: 503 }));
    expect((await forward(args)).status).toBe(503);

    // The runtime may hold the message: the retry dedupes instead of re-sending.
    const retry = await forward(args);
    expect(await retry.json()).toEqual({ status: 'duplicate', deduplicated: true });
  });
});

// ── redirects, CORS, cookies — originMode vs the path form ───────────────────

describe('forwardToSandbox redirect rewriting and CORS', () => {
  const redirect = (location: string) =>
    new Response(null, { status: 302, headers: { location } });

  test('a self redirect is re-prefixed with the path-form prefix', async () => {
    queueFetch(redirect('/login?next=/x'));
    const res = await forward({ port: 3000, path: '/' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/v1/p/ext-1/3000/login?next=/x');
  });

  test('on a preview origin the redirect stays root-relative', async () => {
    queueFetch(redirect('/login?next=/x'));
    const res = await forward({ port: 3000, path: '/', redirectPrefix: '', originMode: true });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?next=/x');
  });

  test('an absolute redirect to the upstream origin is brought back under the prefix', async () => {
    queueFetch(redirect('http://sandbox.local/dash'));
    const res = await forward({ port: 3000, path: '/' });
    expect(res.headers.get('location')).toBe('/v1/p/ext-1/3000/dash');
  });

  test('a genuinely external redirect passes through untouched', async () => {
    queueFetch(redirect('https://idp.example/oauth?client=1'));
    const res = await forward({ port: 3000, path: '/' });
    expect(res.headers.get('location')).toBe('https://idp.example/oauth?client=1');
  });

  test('the Kortix web app origin gets the credentialed CORS grant, a stranger gets nothing', async () => {
    queueFetch(new Response('ok', { status: 200 }));
    const allowed = await forward({ port: 3000, path: '/', origin: 'http://localhost:3000' });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('vary')).toBe('Origin');

    queueFetch(new Response('ok', { status: 200 }));
    const stranger = await forward({ port: 3000, path: '/', origin: 'https://evil.example' });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('on a preview origin the jar gives the app its own cookies and keeps none of ours', async () => {
    recordingFetch(new Response('ok', { status: 200 }));
    await forward({
      port: 3000,
      path: '/',
      redirectPrefix: '',
      originMode: true,
      headers: new Headers({ cookie: 'app_session=abc; __kortix_preview=tok; __preview_session=zzz' }),
    });
    expect(lastFetch?.headers.get('cookie')).toBe('app_session=abc');
  });

  test('the path form never forwards a cookie', async () => {
    recordingFetch(new Response('ok', { status: 200 }));
    await forward({
      port: 3000,
      path: '/',
      headers: new Headers({ cookie: 'app_session=abc' }),
    });
    expect(lastFetch?.headers.get('cookie')).toBeNull();
  });

  test('X-Forwarded-Prefix is the public origin plus the redirect prefix', async () => {
    recordingFetch(new Response('ok', { status: 200 }));
    await forward({ port: 3000, path: '/', publicOrigin: 'https://p.example' });
    expect(lastFetch?.headers.get('x-forwarded-prefix')).toBe('https://p.example/v1/p/ext-1/3000');

    recordingFetch(new Response('ok', { status: 200 }));
    await forward({ port: 3000, path: '/', redirectPrefix: '', publicOrigin: 'https://p.example', originMode: true });
    expect(lastFetch?.headers.get('x-forwarded-prefix')).toBe('https://p.example');
  });
});

// ── resolvePreviewWsUpstream ─────────────────────────────────────────────────

const wsArgs = (overrides?: Partial<Parameters<typeof resolvePreviewWsUpstream>[0]>) => ({
  sandboxId: 'ext-1',
  upstreamPort: 8000,
  userId: 'u1',
  remainingPath: '/kortix/pty/term-1',
  queryString: '',
  callerSessionId: null,
  boundCredentialSessionId: null,
  ...overrides,
});

describe('resolvePreviewWsUpstream', () => {
  test('an unknown sandbox is a 404', async () => {
    currentRecord = null as unknown as Record<string, unknown>;
    expect(await resolvePreviewWsUpstream(wsArgs())).toEqual({
      ok: false,
      status: 404,
      message: 'sandbox not found',
    });
  });

  test('a caller who does not own the sandbox is refused before the session gate', async () => {
    previewAccessAllowed = false;
    const result = await resolvePreviewWsUpstream(wsArgs());
    expect(result).toEqual({ ok: false, status: 403, message: 'not authorized' });
  });

  test('session visibility gates the conversation ports, not an app port', async () => {
    sessionAccessAllowed = false;
    const daemon = await resolvePreviewWsUpstream(wsArgs());
    expect(daemon).toEqual({ ok: false, status: 403, message: 'not authorized for this session' });

    const appPort = await resolvePreviewWsUpstream(wsArgs({ upstreamPort: 3000, remainingPath: '/ws' }));
    expect(appPort.ok).toBe(true);
  });

  test('a stopped box stays 503 unless the attach was marked user-initiated on a PTY path', async () => {
    currentRecord = { ...ACTIVE_RECORD, status: 'stopped' };
    const noWake = await resolvePreviewWsUpstream(wsArgs());
    expect(noWake).toEqual({ ok: false, status: 503, message: 'sandbox not ready (status: stopped)' });
    expect(counts.resumeStopped).toBe(0);

    const markedButNotPty = await resolvePreviewWsUpstream(wsArgs({ wakeRequested: true, remainingPath: '/hmr' }));
    expect(markedButNotPty).toEqual({ ok: false, status: 503, message: 'sandbox not ready (status: stopped)' });
    expect(counts.resumeStopped).toBe(0);
  });

  test('a user-initiated terminal attach claims the wake, answers 503 while parked, then resolves once active', async () => {
    currentRecord = { ...ACTIVE_RECORD, status: 'stopped' };
    const during = await resolvePreviewWsUpstream(wsArgs({ wakeRequested: true }));
    expect(during).toEqual({ ok: false, status: 503, message: 'sandbox not ready (status: stopped)' });
    expect(counts.resumeStopped).toBe(1);

    currentRecord = { ...ACTIVE_RECORD, status: 'active' };
    const after = await resolvePreviewWsUpstream(wsArgs({ wakeRequested: true }));
    expect(after.ok).toBe(true);
  });

  test('the resolved upstream is a ws:// URL carrying the auth headers and the signed context', async () => {
    upstreamAuthHeaders = { [KORTIX_USER_CONTEXT_HEADER]: 'signed-ctx', authorization: 'Bearer svc-key' };
    ingress = {
      url: 'http://sandbox.local',
      headers: {},
      queryToken: { name: 'pv', value: 'tok' },
      websocket: { userContextQueryParam: 'user_ctx', queryDefaults: { tier: 'free' } },
    };
    // ingressTargetUrl only injects the provider token when the CLIENT's query
    // already names that parameter (the anti-shadowing rule); an ordinary query
    // keeps no token. Both shapes are current behavior — pin them.
    const plain = await resolvePreviewWsUpstream(wsArgs({ queryString: '?foo=1' }));
    expect(plain).toEqual({
      ok: true,
      url: 'ws://sandbox.local/kortix/pty/term-1?foo=1&user_ctx=signed-ctx&tier=free',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: 'signed-ctx', authorization: 'Bearer svc-key' },
    });

    const shadowed = await resolvePreviewWsUpstream(wsArgs({ queryString: '?pv=client' }));
    expect(shadowed).toEqual({
      ok: true,
      url: 'ws://sandbox.local/kortix/pty/term-1?pv=tok&pv=client&user_ctx=signed-ctx&tier=free',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: 'signed-ctx', authorization: 'Bearer svc-key' },
    });
  });
});

// ── public-share delegation ──────────────────────────────────────────────────

// `{kind:'public_share'}` through forwardToSandbox (the preview-origin door) and
// the path-form publicShareApp (forwardPublicShare) must return the same status
// and the same body for the same share — the "two doors, one behavior" contract
// the later phases must not split.
const mountedPublicShare = new Hono().route('/v1/p/public-share', publicShareApp);

const SHARE_ROW_COMMON = {
  shareId: 'kps-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  accountId: 'acct-1',
  label: 'shared',
  allowWebsocket: false,
  sandboxStatus: 'active',
  expiresAt: new Date('2030-01-01T00:00:00Z'),
  externalId: 'ext-1',
};

describe('public-share delegation: the origin door matches the path form', () => {
  test('a file share forwards to /open?path=… on the static-file port, both doors', async () => {
    shareRow = { ...SHARE_ROW_COMMON, resourceType: 'file', port: null, path: null, filePath: '/app/report.html', mode: 'view' };
    queueFetch(new Response('file-bytes', { status: 200 }));

    const pathForm = await mountedPublicShare.request('/v1/p/public-share/kps-1/file');
    expect(pathForm.status).toBe(200);
    expect(await pathForm.text()).toBe('file-bytes');

    queueFetch(new Response('file-bytes', { status: 200 }));
    const originForm = await forwardToSandbox(
      'ext-1',
      realPublicShares.STATIC_FILE_SHARE_PORT,
      shareAccess,
      'GET',
      '/open',
      '?path=%2Fapp%2Freport.html',
      new Headers(),
      undefined,
      '',
      '',
      'https://p3211-ext1.localhost:8008',
      { originMode: true },
    );
    expect(originForm.status).toBe(pathForm.status);
    expect(await originForm.text()).toBe('file-bytes');
  });

  test('a preview share forwards to its own port root, both doors', async () => {
    shareRow = { ...SHARE_ROW_COMMON, resourceType: 'preview', port: 3000, path: '/', filePath: null, mode: 'view' };
    queueFetch(new Response('app-html', { status: 200 }));

    const pathForm = await mountedPublicShare.request('/v1/p/public-share/kps-1/3000/');
    expect(pathForm.status).toBe(200);
    expect(await pathForm.text()).toBe('app-html');

    queueFetch(new Response('app-html', { status: 200 }));
    const originForm = await forwardToSandbox(
      'ext-1',
      3000,
      shareAccess,
      'GET',
      '/',
      '',
      new Headers(),
      undefined,
      '',
      '',
      'https://p3000-ext1.localhost:8008',
      { originMode: true },
    );
    expect(originForm.status).toBe(pathForm.status);
    expect(await originForm.text()).toBe('app-html');
  });

  test('a file share outside its own path stays refused on the path form', async () => {
    shareRow = { ...SHARE_ROW_COMMON, resourceType: 'file', port: null, path: null, filePath: '/app/report.html', mode: 'view' };
    const res = await mountedPublicShare.request('/v1/p/public-share/kps-1/file/other');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Not authorized for this file path' });
  });
});
