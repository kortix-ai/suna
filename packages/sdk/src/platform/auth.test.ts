import { test, expect, beforeEach } from 'bun:test';
import { configureKortix } from './config';
import { authenticatedFetch, getSupabaseAccessTokenWithRetry, getAuthTokenWithRetry } from './auth';

// NOTE: unlike files/client.test.ts / opencode/client.test.ts / session/session.test.ts
// (which each `mock.module('../platform/auth', ...)` to fully replace this module for
// their own purposes), this file tests the REAL implementation directly — it must NOT
// itself `mock.module` this path.

let tokenCallCount = 0;
let tokenSequence: Array<string | null> = [];

beforeEach(() => {
  tokenCallCount = 0;
  tokenSequence = [];
  configureKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => {
      const t = tokenSequence[Math.min(tokenCallCount, tokenSequence.length - 1)] ?? null;
      tokenCallCount += 1;
      return t;
    },
  });
});

// ── getSupabaseAccessTokenWithRetry / getAuthTokenWithRetry — actually retries
// now (previously accepted attempts/baseDelayMs/invalidateBetweenAttempts and
// silently ignored all three) ───────────────────────────────────────────────

test('retries until getToken() returns a truthy token, up to `attempts`', async () => {
  tokenSequence = [null, null, 'tok-3'];
  const token = await getSupabaseAccessTokenWithRetry({ attempts: 3, baseDelayMs: 0 });
  expect(token).toBe('tok-3');
  expect(tokenCallCount).toBe(3);
});

test('gives up after `attempts` and returns the last (falsy) result — never retries forever', async () => {
  tokenSequence = [null, null, null, null];
  const token = await getSupabaseAccessTokenWithRetry({ attempts: 2, baseDelayMs: 0 });
  expect(token).toBeNull();
  expect(tokenCallCount).toBe(2);
});

test('defaults to a single attempt (no retry) when options are omitted', async () => {
  tokenSequence = [null, 'tok'];
  const token = await getSupabaseAccessTokenWithRetry();
  expect(token).toBeNull();
  expect(tokenCallCount).toBe(1);
});

test('getAuthTokenWithRetry delegates the same retry semantics', async () => {
  tokenSequence = [null, 'tok-2'];
  const token = await getAuthTokenWithRetry({ attempts: 2, baseDelayMs: 0 });
  expect(token).toBe('tok-2');
  expect(tokenCallCount).toBe(2);
});

// ── authenticatedFetch — default 30s timeout, EXCEPT for the SSE event stream
// endpoint, and composed with any caller-supplied signal ────────────────────

function captureFetch() {
  const seen: { input: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({ input, init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return seen;
}

function signalOf(entry: { input: unknown; init?: RequestInit }): AbortSignal | undefined {
  if (entry.init?.signal) return entry.init.signal;
  return entry.input instanceof Request ? entry.input.signal : undefined;
}

test('applies a default (non-aborted) timeout signal to a non-streaming request', async () => {
  tokenSequence = ['tok'];
  const seen = captureFetch();

  await authenticatedFetch('http://sbx.test/kortix/health');

  const signal = signalOf(seen[0]);
  expect(signal).toBeDefined();
  expect(signal?.aborted).toBe(false);
});

test('does NOT impose a default timeout on the SSE event stream endpoint (/global/event)', async () => {
  tokenSequence = ['tok'];
  const seen = captureFetch();

  await authenticatedFetch('http://sbx.test/global/event');

  // No caller signal was supplied and this is the exempted streaming path —
  // no timeout signal should have been synthesized/attached.
  expect(seen[0].init?.signal).toBeUndefined();
});

test('composes a caller-supplied signal with the default timeout on a non-streaming request', async () => {
  tokenSequence = ['tok'];
  const seen = captureFetch();

  const controller = new AbortController();
  controller.abort();
  await authenticatedFetch('http://sbx.test/kortix/health', { signal: controller.signal });

  const signal = signalOf(seen[0]);
  expect(signal?.aborted).toBe(true); // the already-aborted caller signal propagates through AbortSignal.any
});

test('preserves the caller-supplied signal as-is on the streaming endpoint (never overridden)', async () => {
  tokenSequence = ['tok'];
  const seen = captureFetch();

  const controller = new AbortController();
  await authenticatedFetch('http://sbx.test/global/event', { signal: controller.signal });

  const signal = signalOf(seen[0]);
  expect(signal).toBe(controller.signal);
});

test('returns a synthetic 401 (no network call) when getToken() resolves to null', async () => {
  tokenSequence = [null];
  const seen = captureFetch();

  const res = await authenticatedFetch('http://sbx.test/kortix/health');

  expect(res.status).toBe(401);
  expect(seen.length).toBe(0);
});
