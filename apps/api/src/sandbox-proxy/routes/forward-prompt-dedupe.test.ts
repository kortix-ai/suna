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
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
import * as realRequestContext from '../../lib/request-context';
import * as realPreviewOwnership from '../../shared/preview-ownership';
import * as realKortixUserContext from '../../shared/kortix-user-context';

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
mock.module('../../lib/request-context', () => ({
  ...realRequestContext,
  getTraceHeaders: () => ({}),
}));
// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand silently deletes every other one — and the failure lands
// in whatever unrelated file imports the missing name next, as
// `SyntaxError: Export named '…' not found`, attributed to no test at all.
// Overriding only what this file needs keeps new exports working by default.
mock.module('../../shared/kortix-user-context', () => ({
  ...realKortixUserContext,
  KORTIX_USER_CONTEXT_HEADER: 'x-kortix-user-context',
}));
mock.module('../../shared/preview-ownership', () => ({
  ...realPreviewOwnership,
  canAccessPreviewSandbox: async () => true,
  canAccessSandboxSession: async () => true,
}));
// The connector pre-flight now runs on every turn-start. This file is about a
// different concern, so keep it satisfied — unstubbed it reaches a real DB.
mock.module('../../projects/lib/prompt-connector-preflight', () => ({
  PromptConnectorPreflightUnresolved: class PromptConnectorPreflightUnresolved extends Error {},
  missingPromptConnectorConnections: async () => ({ ok: true }),
}));
mock.module('../../projects/lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));
// Same reason as the env sync above: the pre-prompt grant re-mint reads the
// session's token row, and this file is about DELIVERY dedupe, not grants. It
// is deliberately NOT a no-op stub of convenience — the real function fails the
// prompt CLOSED when it cannot read the token (a prompt must never run under an
// unverified grant), so an unmocked db here turns every delivery test red for a
// reason that has nothing to do with delivery.
mock.module('../../projects/lib/session-token-grant', () => ({
  remintGrantForAgentSwitch: async () => ({ action: 'skip' }),
  SessionGrantRemintError: class SessionGrantRemintError extends Error {},
}));
mock.module('../../projects/opencode-session-snapshot', () => ({
  scheduleOpencodeSnapshotSync: () => {},
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
// Restore per TEST, not just once at the end. Every case installs its own stub
// via queueFetch(), so a case that fails before reaching it would otherwise run
// against the PREVIOUS case's exhausted queue and die with "fetch called more
// times than queued" — turning one real failure into a cascade that hides which
// assertion actually broke.
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});
afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

describe('forwardToSandbox — prompt delivery is never double-sent', () => {
  test('a prompt POST that 502s is delivered to the sandbox at most once', async () => {
    queueFetch(new Response('bad gateway', { status: 502 }));
    const res = await forwardToSandbox(
      'sb-1',
      8000,
      { kind: 'principal', userId: 'u1', callerSessionId: null, sandboxAuthored: false },
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders(),
      PROMPT_BODY,
      'http://app.local',
    );
    // Exactly ONE upstream attempt — the 502 is passed straight through, never retried.
    expect(fetchCalls).toBe(1);
    expect(res.status).toBe(502);
  });

  test('a prompt POST that succeeds is forwarded once (happy path unchanged)', async () => {
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const res = await forwardToSandbox(
      'sb-1',
      8000,
      { kind: 'principal', userId: 'u1', callerSessionId: null, sandboxAuthored: false },
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders(),
      PROMPT_BODY,
      'http://app.local',
    );
    expect(fetchCalls).toBe(1);
    expect(res.status).toBe(200);
  });

  test('a duplicate inbound prompt under the same Idempotency-Key short-circuits', async () => {
    queueFetch(new Response('{"info":{},"parts":[]}', { status: 200 }));
    const args = [
      'sb-1',
      8000,
      { kind: 'principal', userId: 'u1', callerSessionId: null, sandboxAuthored: false } as const,
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders({ 'idempotency-key': 'dup-1' }),
      PROMPT_BODY,
      'http://app.local',
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
    queueFetch(new Response('bad gateway', { status: 502 }), new Response('ok', { status: 200 }));
    const res = await forwardToSandbox(
      'sb-1',
      8000,
      { kind: 'principal', userId: 'u1', callerSessionId: null, sandboxAuthored: false },
      'GET',
      '/session',
      '',
      new Headers(),
      undefined,
      'http://app.local',
    );
    expect(fetchCalls).toBe(2);
    expect(res.status).toBe(200);
  });
});

describe('forwardToSandbox — a sandbox-down 400 on the LAST attempt releases the claim', () => {
  const sandboxDown = () =>
    new Response('failed to get runner info: no IP address found', { status: 400 });

  test('the retry re-delivers instead of getting a bogus 200 duplicate', async () => {
    // The reviewer's catch on this PR. The Daytona sandbox-down branch used to be
    // `if (status === 400 && attempt < MAX_RETRIES)`, so on the FINAL attempt it
    // fell through and returned the 400 to the client with the dedupe claim still
    // held. The client's retry under the same Idempotency-Key then short-circuited
    // to `{status:'duplicate'}` and the user's prompt was silently lost — the very
    // message-loss this PR exists to stop, surviving in the one path it missed.
    //
    // Daytona rejects this BEFORE opencode ("no IP address found" means the box has
    // no runner at all), so delivery is provably not-delivered and releasing is safe.
    const args = [
      'sb-1',
      8000,
      { kind: 'principal', userId: 'u1', callerSessionId: null, sandboxAuthored: false } as const,
      'POST',
      '/session/sess-1/message',
      '',
      jsonHeaders({ 'idempotency-key': 'down-1' }),
      PROMPT_BODY,
      'http://app.local',
    ] as const;

    // MAX_RETRIES = 3 → four attempts, every one sandbox-down.
    queueFetch(sandboxDown(), sandboxDown(), sandboxDown(), sandboxDown());
    const first = await forwardToSandbox(...args);
    expect(first.status).toBe(400);

    // THE ASSERTION: the retry must actually reach the sandbox again. Before the
    // fix this was 0 fetches and a 200 "duplicate".
    queueFetch(new Response('{"ok":true}', { status: 200 }));
    const retry = await forwardToSandbox(...args);
    expect(fetchCalls).toBe(1);
    expect(retry.status).toBe(200);
    expect(await retry.json()).not.toEqual({ status: 'duplicate', deduplicated: true });
  });
});
