// forwardToSandbox must deliver a PROMPT body to the sandbox at most once. The
// proxy buffers the POST body and retries on 502/503/timeout; for an idempotent
// GET that's fine, but a prompt POST the sandbox may already have accepted must
// never be re-sent — a re-POST enqueues the user's message again (the 3x-queued
// bug). These tests pin: (a) a prompt POST that 502s is fetched exactly once,
// (b) a GET still retries, (c) a duplicate inbound prompt under the same
// Idempotency-Key short-circuits without re-hitting the upstream.
//
// The heavier ../backend + ownership + env-sync deps are mocked to inert stubs.
// `bun:test`'s mock.module is process-global, so this lives in its own file (run
// per-file) to avoid leaking stubs into sibling suites — same caveat other
// sandbox-proxy tests document.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';

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

mock.module('../../config', () => ({ config: { KORTIX_ENFORCE_SESSION_AGENT_LOCK: false } }));
mock.module('../../lib/request-context', () => ({ getTraceHeaders: () => ({}) }));
mock.module('../../shared/kortix-user-context', () => ({
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
}));
mock.module('../../shared/preview-ownership', () => ({
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));
mock.module('../../projects/opencode-title-capture', () => ({
  scheduleTitleCaptureAfterPrompt: () => {},
}));
mock.module('../../projects/routes/shared', () => ({
  resumeStoppedSandboxByExternalId: async () => true,
}));
mock.module('../backend', () => ({
  loadSandbox: async () => ({ ...ACTIVE_RECORD }),
  routeSandboxIngress: () => ({ effectivePort: 8000 }),
  resolveSandboxIngress: async () => ({ url: 'http://sandbox.local', headers: {} }),
  buildSandboxUpstreamHeaders: async () => ({}),
  invalidatePreviewLink: () => {},
  markSandboxUsed: () => {},
  markSandboxErrored: async () => {},
  wakeSandbox: async () => {},
}));

const { forwardToSandbox } = await import('./preview');
const { __resetPromptDedupe } = await import('../prompt-dedupe');

const ORIGINAL_FETCH = globalThis.fetch;
let fetchCalls = 0;
let responses: Response[] = [];

function queueFetch(...rs: Response[]) {
  responses = rs;
  fetchCalls = 0;
  (globalThis as { fetch: unknown }).fetch = async () => {
    fetchCalls += 1;
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than queued');
    return next;
  };
}

function jsonHeaders(extra?: Record<string, string>): Headers {
  return new Headers({ 'content-type': 'application/json', ...(extra ?? {}) });
}

const PROMPT_BODY = new TextEncoder().encode(
  JSON.stringify({ parts: [{ type: 'text', text: 'hi' }] }),
).buffer;

beforeEach(() => __resetPromptDedupe());
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('forwardToSandbox — prompt delivery is never double-sent', () => {
  test('a prompt POST that 502s is delivered to the sandbox at most once', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }));
    const res = await forwardToSandbox(
      'sb-1', 8000, { kind: 'principal', userId: 'u1' },
      'POST', '/session/sess-1/message', '', jsonHeaders(), PROMPT_BODY, 'http://app.local',
    );
    // Exactly ONE upstream attempt — the 502 is passed straight through, never retried.
    expect(fetchCalls).toBe(1);
    expect(res.status).toBe(502);
  });

  test('a prompt POST that succeeds is forwarded once (happy path unchanged)', async () => {
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const res = await forwardToSandbox(
      'sb-1', 8000, { kind: 'principal', userId: 'u1' },
      'POST', '/session/sess-1/message', '', jsonHeaders(), PROMPT_BODY, 'http://app.local',
    );
    expect(fetchCalls).toBe(1);
    expect(res.status).toBe(200);
  });

  test('a duplicate inbound prompt under the same Idempotency-Key short-circuits', async () => {
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const args = [
      'sb-1', 8000, { kind: 'principal', userId: 'u1' } as const,
      'POST', '/session/sess-1/message', '', jsonHeaders({ 'idempotency-key': 'dup-1' }),
      PROMPT_BODY, 'http://app.local',
    ] as const;
    const first = await forwardToSandbox(...args);
    const second = await forwardToSandbox(...args);
    // Only the first reached the upstream; the second was deduped.
    expect(fetchCalls).toBe(1);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: 'duplicate', deduplicated: true });
  });
});

describe('forwardToSandbox — idempotent GET retry is unchanged', () => {
  test('a GET that 502s then 200s is retried and returns the eventual success', async () => {
    queueFetch(
      new Response('bad gateway', { status: 502 }),
      new Response('ok', { status: 200 }),
    );
    const res = await forwardToSandbox(
      'sb-1', 8000, { kind: 'principal', userId: 'u1' },
      'GET', '/session', '', new Headers(), undefined, 'http://app.local',
    );
    expect(fetchCalls).toBe(2);
    expect(res.status).toBe(200);
  });
});
