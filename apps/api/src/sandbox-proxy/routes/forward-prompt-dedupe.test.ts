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

// The mirror image of "never double-sent": a prompt that NEVER reaches the
// sandbox must not leave its dedupe claim stuck, or a client that retries on the
// transport failure would short-circuit to a 200 "duplicate" for a message the
// sandbox never saw — silent message loss. The claim is released ONLY when the
// failure PROVES non-delivery (connection refused / pre-fetch), and KEPT on an
// ambiguous mid-flight failure where opencode may already hold the message.
describe('forwardToSandbox — an undelivered prompt does not stay claimed', () => {
  // fetch is overridden per test and restored by the file-level afterAll; the
  // GET-retry suite that follows re-sets it via queueFetch, so no leak either way.
  test('every attempt refused (nothing reached the box) → claim released, retry re-delivers', async () => {
    let attempts = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      attempts += 1;
      // First forwardToSandbox: attempts 1..4 all refuse (PROVES nothing landed).
      // The retry's attempt (5) succeeds — only reachable if the claim was
      // released, since a still-claimed key would short-circuit BEFORE any fetch.
      if (attempts <= 4) {
        const err = new Error('connect ECONNREFUSED 127.0.0.1:8000') as Error & { code?: string };
        err.code = 'ECONNREFUSED';
        throw err;
      }
      return new Response('{"info":{},"parts":[]}', { status: 200 });
    };
    const args = [
      'sb-1', 8000, { kind: 'principal', userId: 'u1' } as const,
      'POST', '/session/sess-1/message', '', jsonHeaders({ 'idempotency-key': 'refused-1' }),
      PROMPT_BODY, 'http://app.local',
    ] as const;

    const first = await forwardToSandbox(...args);
    expect(first.status).toBe(502); // friendly unreachable — never delivered
    const attemptsAfterFirst = attempts;
    expect(attemptsAfterFirst).toBeGreaterThan(1); // it really did retry, not short-circuit

    const second = await forwardToSandbox(...args);
    // Claim was released: the retry RE-ATTEMPTS delivery (fetch is hit again)
    // rather than returning a phantom "duplicate".
    expect(attempts).toBeGreaterThan(attemptsAfterFirst);
    expect(second.status).toBe(200);
    expect(await second.json()).not.toEqual({ status: 'duplicate', deduplicated: true });
  }, 20_000);

  test('an AMBIGUOUS mid-flight failure (reset) KEEPS the claim — retry must not re-POST', async () => {
    let attempts = 0;
    (globalThis as { fetch: unknown }).fetch = async () => {
      attempts += 1;
      const err = new Error('read ECONNRESET') as Error & { code?: string };
      err.code = 'ECONNRESET'; // reset ≠ refused → ambiguous: opencode may hold it
      throw err;
    };
    const args = [
      'sb-1', 8000, { kind: 'principal', userId: 'u1' } as const,
      'POST', '/session/sess-1/message', '', jsonHeaders({ 'idempotency-key': 'reset-1' }),
      PROMPT_BODY, 'http://app.local',
    ] as const;

    const first = await forwardToSandbox(...args);
    // Ambiguous → not retried and not released; exactly one POST left the proxy.
    expect(first.status).toBe(502);
    expect(attempts).toBe(1);

    const second = await forwardToSandbox(...args);
    // Claim kept → the retry short-circuits to a duplicate no-op WITHOUT a second
    // POST, so a message opencode may already hold is never enqueued twice.
    expect(attempts).toBe(1);
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
