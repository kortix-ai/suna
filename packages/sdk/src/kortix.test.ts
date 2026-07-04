import { test, expect, beforeEach, mock } from 'bun:test';
import { createKortix, SessionNotReadyError } from './kortix';
import { isConfigured } from './platform/config';

// Capture every outbound request the facade makes.
let calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: true, secrets: [], candidates: [], sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('createKortix wires the platform seam', () => {
  expect(isConfigured()).toBe(true);
});

test('facade exposes the core namespaces', () => {
  expect(typeof kortix.projects.list).toBe('function');
  expect(typeof kortix.accounts.list).toBe('function');
  expect(typeof kortix.project).toBe('function');
  expect(typeof kortix.session).toBe('function');
  expect(typeof kortix.runtime).toBe('function');
});

test('project(id) handle binds the id and hits the right endpoint', async () => {
  await kortix.project('PID123').secrets.list();
  expect(last().url).toContain('/projects/PID123/secrets');
  expect(last().method).toBe('GET');
});

test('session(projectId, sessionId) binds both ids', async () => {
  await kortix.session('PID123', 'SID456').previews();
  expect(last().url).toContain('/projects/PID123/sessions/SID456/previews');
});

test('project(id).session(sid) is the same session handle', async () => {
  await kortix.project('PA').session('SB').get();
  expect(last().url).toContain('/projects/PA/sessions/SB');
});

test('top-level projects.list hits /projects', async () => {
  await kortix.projects.list();
  expect(last().url).toContain('/projects');
});

test('session(...).audit hits the audit endpoint with the given limit', async () => {
  await kortix.session('PID123', 'SID456').audit(10);
  expect(last().url).toContain('/projects/PID123/sessions/SID456/audit?limit=10');
});

// ── per-handle runtime isolation (regression: two session handles used to
// share the module-global "active runtime", so the second handle's
// ensureReady() silently redirected the first handle's send/health/preview
// calls to the wrong sandbox) ──────────────────────────────────────────────

function sessionStartPayload(externalId: string, opencodeSessionId: string) {
  return {
    stage: 'ready',
    agent_name: 'agent',
    retriable: false,
    sandbox: { external_id: externalId },
    opencode_session_id: opencodeSessionId,
  };
}

function requestUrl(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockTwoSessionRuntimes() {
  return mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-A/start')) {
      return jsonResponse(sessionStartPayload('sb-A', 'ocs-A'));
    }
    if (url.includes('/sessions/SESS-B/start')) {
      return jsonResponse(sessionStartPayload('sb-B', 'ocs-B'));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

test('two session handles resolve independent runtimes: A.send never crosses to B (or back)', async () => {
  globalThis.fetch = mockTwoSessionRuntimes();
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  const a = k.session('PROJ', 'SESS-A');
  const b = k.session('PROJ', 'SESS-B');

  await a.ensureReady();
  await b.ensureReady(); // resolves AFTER a — used to clobber the shared global runtime

  await a.send('hello from A');
  const aPromptCall = calls.find((c) => c.url.includes('/message'));
  expect(aPromptCall?.url).toContain('/p/sb-A/8000');
  expect(aPromptCall?.url).not.toContain('sb-B');

  calls.length = 0;
  await b.send('hello from B');
  const bPromptCall = calls.find((c) => c.url.includes('/message'));
  expect(bPromptCall?.url).toContain('/p/sb-B/8000');
  expect(bPromptCall?.url).not.toContain('sb-A');

  calls.length = 0;
  await a.abort();
  const aAbortCall = calls.find((c) => c.url.includes('/abort'));
  expect(aAbortCall?.url).toContain('/p/sb-A/8000');
  expect(aAbortCall?.url).not.toContain('sb-B');
});

test('previewUrl uses the handle\'s own sandbox id, not whichever session resolved last', async () => {
  globalThis.fetch = mockTwoSessionRuntimes();
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  const a = k.session('PROJ', 'SESS-A');
  const b = k.session('PROJ', 'SESS-B');

  await a.ensureReady();
  await b.ensureReady();

  expect(a.previewUrl(3000, '/docs')).toBe('http://test.local/p/sb-A/3000/docs');
  expect(b.previewUrl(3000, '/docs')).toBe('http://test.local/p/sb-B/3000/docs');
});

test('previewUrl()/proxyUrl()/runtime throw SessionNotReadyError before ensureReady()', () => {
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const s = k.session('PROJ', 'SESS-NEW');

  expect(() => s.previewUrl(3000)).toThrow(SessionNotReadyError);
  expect(() => s.proxyUrl('http://localhost:3000')).toThrow(SessionNotReadyError);
  expect(() => s.runtime).toThrow(SessionNotReadyError);
});

// health() is a liveness POLL, not an action gated on the runtime being up —
// pollers (e.g. a header dot ticking every 15s on a fresh inline
// `kortix.session(...)` handle, see apps/whitelabel-demo/session-header.tsx)
// must be able to call it before the session has ever resolved a runtime, so
// it degrades to the graceful "no URL yet" shape instead of throwing.
test('health() resolves gracefully (ok: false) before ensureReady() instead of throwing', async () => {
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const s = k.session('PROJ', 'SESS-NEVER-STARTED');

  const result = await s.health();
  expect(result.ok).toBe(false);
  expect(result.status).toBe(0);
});

test('health() resolves against the handle\'s own runtime URL once ready', async () => {
  globalThis.fetch = mockTwoSessionRuntimes();
  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const a = k.session('PROJ', 'SESS-A');

  await a.ensureReady();
  calls.length = 0;
  await a.health();

  expect(calls.some((c) => c.url.includes('/p/sb-A/8000/kortix/health'))).toBe(true);
});

// ── shared session-runtime registry (regression: apps/whitelabel-demo's
// session-header.tsx polls health() on a FRESH `kortix.session(...)` handle
// every 15s, and preview-panel.tsx calls previewUrl() in render on a handle
// that never itself called ensureReady() — both used to throw
// SessionNotReadyError forever because a handle's `_ready` cache never
// survived past that one instance) ──────────────────────────────────────────

test('a second fresh handle for the same session adopts the registry entry — no ensureReady() of its own needed', async () => {
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-REG-1/start')) {
      return jsonResponse(sessionStartPayload('sb-reg1', 'ocs-reg1'));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const first = k.session('PROJ', 'SESS-REG-1');
  await first.ensureReady();

  // Brand-new handle for the SAME (projectId, sessionId) — never called ensureReady.
  const second = k.session('PROJ', 'SESS-REG-1');
  expect(second.previewUrl(4000, '/y')).toBe('http://test.local/p/sb-reg1/4000/y');

  calls.length = 0;
  const health = await second.health();
  expect(health.ok).toBe(true);
  expect(calls.some((c) => c.url.includes('/p/sb-reg1/8000/kortix/health'))).toBe(true);
});

test('restart clears the registry entry so a subsequent send re-resolves the runtime', async () => {
  let startCount = 0;
  globalThis.fetch = mock(async (input: unknown) => {
    const url = requestUrl(input);
    calls.push({ url, method: 'POST' });
    if (url.includes('/sessions/SESS-REG-2/start')) {
      startCount += 1;
      const sandboxId = startCount === 1 ? 'sb-reg2-old' : 'sb-reg2-new';
      return jsonResponse(sessionStartPayload(sandboxId, `ocs-reg2-${startCount}`));
    }
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;

  const k = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
  const handle = k.session('PROJ', 'SESS-REG-2');

  await handle.ensureReady();
  expect(startCount).toBe(1);

  await handle.restart();

  calls.length = 0;
  await handle.send('hello again');
  const promptCall = calls.find((c) => c.url.includes('/message'));
  expect(promptCall?.url).toContain('/p/sb-reg2-new/8000');
  expect(startCount).toBe(2);
});
