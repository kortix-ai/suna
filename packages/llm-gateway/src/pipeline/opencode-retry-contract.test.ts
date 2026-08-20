import { describe, expect, test } from 'bun:test';

import { createGateway } from '../create-gateway';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import type { FetchImpl } from '../http';
import { MAX_RELAYED_RETRY_AFTER_SECONDS, clampRetryAfterSeconds } from './error-response';

// ---------------------------------------------------------------------------
// The exact retry contract OpenCode 1.18.19 enforces on a gateway response.
//
// Extracted from the shipped `opencode-darwin-arm64@1.18.19` binary
// (`SessionRetry`), verbatim:
//
//   RETRY_MAX_RETRIES        = 5
//   RETRY_INITIAL_DELAY      = 2000
//   RETRY_BACKOFF_FACTOR     = 2
//   RETRY_JITTER_FACTOR      = 0.25
//   RETRY_MAX_DELAY_NO_HEADERS = 30000
//   RETRY_MAX_DELAY          = 2147483647          // 24.8 days
//   PATTERNS[0]              = /429|500|502|503|504|524/i
//
//   retryable(e) {
//     if (ContextOverflowError.isInstance(e)) return;              // no retry
//     if (APIError.isInstance(e)) {
//       const s = e.data.statusCode;
//       if (!e.data.isRetryable && !(s !== undefined && s >= 500)
//           && !match(e.data.message) && !match(e.data.responseBody)) return;
//       ...                                                        // RETRY
//
// `match()` runs the unanchored patterns over the RAW body text, so ANY "500"
// anywhere in a terminal 400/401/403 body makes OpenCode replay the whole
// prompt five times. These tests pin the gateway side of that contract.
// ---------------------------------------------------------------------------
const OPENCODE_RETRY_STATUS_PATTERN = /429|500|502|503|504|524/i;

const principal = { userId: 'u1', accountId: 'a1', projectId: 'p1', keyId: 'k1' };

const managed: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://up.test/v1',
  apiKey: 'sk',
  billingMode: 'credits',
  markup: 2,
};

// ONE transport attempt — the shipped default (apps/llm-gateway/src/config.ts).
// Every test here runs on it so the assertions describe production behaviour.
const productionRetry = { sleep: async () => {}, rand: () => 0.5, baseDelayMs: 1, maxAttempts: 1 };

function makeHooks(over: Partial<GatewayHooks> = {}) {
  const usage: UsageEvent[] = [];
  const traces: GatewayTrace[] = [];
  const hooks: GatewayHooks = {
    authenticate: async (token) => (token === 'good' ? principal : null),
    resolveUpstream: async () => [managed],
    assertBillingActive: async () => {},
    recordUsage: async (event) => {
      usage.push(event);
    },
    recordTrace: async (trace) => {
      traces.push(trace);
    },
    ...over,
  };
  return { hooks, usage, traces };
}

const flush = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 5));

const chatBody = '{"model":"x","messages":[{"role":"user","content":"hi"}]}';

const goodJson = JSON.stringify({
  id: 'c1',
  model: 'x',
  choices: [{ message: { role: 'assistant', content: 'real answer' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3 },
});
const emptyJson = JSON.stringify({
  id: 'c1',
  model: 'x',
  choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 0, completion_tokens: 0 },
});

/**
 * The body text OpenCode would regex, minus the request id.
 *
 * `req_<base36 time><base36 random>` is ~16 random alphanumerics, so it carries
 * a ~0.2% chance of containing "500"/"429"/... by accident. That is a real (if
 * tiny) residual exposure, but it is not what these tests are asserting, and
 * leaving it in would make them flaky.
 */
function scrubRequestId(raw: string, requestId: string): string {
  return raw.split(requestId).join('<request-id>');
}

describe('OpenCode >= 1.18.14 retry-regex contract', () => {
  test('a terminal 400 does NOT serialize a prior candidate 500 — the $-per-retry bug', async () => {
    const a: UpstreamDescriptor = { ...managed, provider: 'a', baseUrl: 'https://a.test/v1' };
    const b: UpstreamDescriptor = { ...managed, provider: 'b', baseUrl: 'https://b.test/v1' };
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [a, b] });

    // Candidate A: a transient 500 (recorded in the chain, then failed over).
    // Candidate B: a PERMANENT 400 — the status the client actually receives.
    const fetchImpl: FetchImpl = async (url) =>
      new URL(url).hostname === 'a.test'
        ? new Response('{"error":{"message":"upstream exploded"}}', { status: 500 })
        : new Response('{"error":{"message":"bad request"}}', { status: 400 });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(400);
    const raw = await res.text();
    const body = JSON.parse(raw) as { request_id: string; attempt_failures?: unknown[] };

    // THE ASSERTION THAT COSTS MONEY WHEN IT FAILS: nothing in the body of a
    // permanent 400 may match OpenCode's retry pattern.
    expect(OPENCODE_RETRY_STATUS_PATTERN.test(scrubRequestId(raw, body.request_id))).toBe(false);
    for (const failure of body.attempt_failures ?? []) {
      expect((failure as { status?: number }).status).toBeUndefined();
    }

    // The chain itself is NOT lost — it is recorded in full on the trace, which
    // is where it is read when debugging.
    await flush();
    expect(traces[0].attemptFailures?.map((f) => f.status)).toContain(500);
  });

  test('positive control: the same 500 IS serialized when the outer status is 5xx', async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":{"message":"upstream exploded"}}', { status: 500 });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    // 502: every candidate was unreachable. OpenCode retries this on the status
    // alone, so hiding the diagnostics here would buy nothing.
    expect(res.status).toBe(502);
    const body = (await res.json()) as { attempt_failures: Array<{ status?: number }> };
    expect(body.attempt_failures[0].status).toBe(500);
  });

  test('a terminal 401 does NOT serialize a prior candidate 503', async () => {
    const a: UpstreamDescriptor = { ...managed, provider: 'a', baseUrl: 'https://a.test/v1' };
    const b: UpstreamDescriptor = { ...managed, provider: 'b', baseUrl: 'https://b.test/v1' };
    const { hooks } = makeHooks({ resolveUpstream: async () => [a, b] });
    const fetchImpl: FetchImpl = async (url) =>
      new URL(url).hostname === 'a.test'
        ? new Response('{"error":{"message":"upstream busy"}}', { status: 503 })
        : new Response('{"error":{"message":"no access"}}', { status: 401 });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(401);
    const raw = await res.text();
    const body = JSON.parse(raw) as { request_id: string };
    expect(OPENCODE_RETRY_STATUS_PATTERN.test(scrubRequestId(raw, body.request_id))).toBe(false);
  });

  test('the Anthropic /v1/messages ingress is clean on the same chain', async () => {
    // The Anthropic envelope relays only `message` from the chat body, so it
    // inherits the gate through `failureChainMessage` — pinned here because it
    // is a SECOND client-facing surface over the same pipeline.
    const a: UpstreamDescriptor = { ...managed, provider: 'a', baseUrl: 'https://a.test/v1' };
    const b: UpstreamDescriptor = { ...managed, provider: 'b', baseUrl: 'https://b.test/v1' };
    const { hooks } = makeHooks({ resolveUpstream: async () => [a, b] });
    const fetchImpl: FetchImpl = async (url) =>
      new URL(url).hostname === 'a.test'
        ? new Response('{"error":{"message":"upstream exploded"}}', { status: 500 })
        : new Response('{"error":{"message":"bad request"}}', { status: 400 });

    const res = await createGateway(hooks, { retry: productionRetry }, { fetchImpl }).messages({
      authorization: 'Bearer good',
      rawBody: JSON.stringify({
        model: 'x',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(JSON.parse(raw).type).toBe('error');
    expect(OPENCODE_RETRY_STATUS_PATTERN.test(raw)).toBe(false);
  });
});

describe('one transport attempt — OpenCode owns transport retry', () => {
  test('a retryable 500 is dispatched exactly ONCE per candidate', async () => {
    let calls = 0;
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return new Response('{"error":{"message":"boom"}}', { status: 500 });
    };

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(502);
    expect(calls).toBe(1);
  });

  test('402 quota failover to the next candidate SURVIVES maxAttempts: 1', async () => {
    const byok: UpstreamDescriptor = {
      ...managed,
      provider: 'byok',
      baseUrl: 'https://byok.test/v1',
    };
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [byok, managed] });
    const fetchImpl: FetchImpl = async (url) =>
      new URL(url).hostname === 'byok.test'
        ? new Response('{"error":{"message":"insufficient_quota"}}', { status: 402 })
        : new Response(goodJson, { status: 200, headers: { 'content-type': 'application/json' } });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('real answer');
    await flush();
    expect(traces[0].candidatesTried).toEqual(['byok', 'openrouter']);
  });

  test('403 quota failover to the next candidate SURVIVES maxAttempts: 1', async () => {
    const byok: UpstreamDescriptor = {
      ...managed,
      provider: 'byok',
      baseUrl: 'https://byok.test/v1',
    };
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [byok, managed] });
    const fetchImpl: FetchImpl = async (url) =>
      new URL(url).hostname === 'byok.test'
        ? new Response('{"error":{"message":"model access denied"}}', { status: 403 })
        : new Response(goodJson, { status: 200, headers: { 'content-type': 'application/json' } });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(200);
    await flush();
    expect(traces[0].candidatesTried).toEqual(['byok', 'openrouter']);
  });

  test('429 quota failover to the next candidate SURVIVES maxAttempts: 1', async () => {
    const byok: UpstreamDescriptor = {
      ...managed,
      provider: 'byok',
      baseUrl: 'https://byok.test/v1',
    };
    const { hooks } = makeHooks({ resolveUpstream: async () => [byok, managed] });
    const fetchImpl: FetchImpl = async (url) =>
      new URL(url).hostname === 'byok.test'
        ? new Response('{"error":{"message":"rate limited"}}', { status: 429 })
        : new Response(goodJson, { status: 200, headers: { 'content-type': 'application/json' } });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(200);
  });

  test('empty-200-completion retry still runs 3x per candidate on maxAttempts: 1', async () => {
    // NOT a transport retry: an empty 200 never throws, so `maxAttempts` never
    // sees it. It is bounded by MAX_INVALID_COMPLETION_ATTEMPTS_PER_CANDIDATE.
    let calls = 0;
    const { hooks, traces } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return new Response(calls < 3 ? emptyJson : goodJson, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('real answer');
    expect(calls).toBe(3);
    await flush();
    expect(traces[0].candidatesTried).toEqual(['openrouter', 'openrouter', 'openrouter']);
  });
});

describe('relayed Retry-After is clamped', () => {
  test('clampRetryAfterSeconds bounds every input form', () => {
    expect(MAX_RELAYED_RETRY_AFTER_SECONDS).toBe(60);
    // The 24.8-day park OpenCode 1.18.17 would otherwise honour verbatim.
    expect(clampRetryAfterSeconds('2147483')).toBe(60);
    expect(clampRetryAfterSeconds('86400')).toBe(60);
    expect(clampRetryAfterSeconds('61')).toBe(60);
    expect(clampRetryAfterSeconds('60')).toBe(60);
    expect(clampRetryAfterSeconds('12')).toBe(12);
    expect(clampRetryAfterSeconds('1.2')).toBe(2);
    // Absent / malformed / already-elapsed → relay nothing, let the client back
    // off on its own schedule.
    expect(clampRetryAfterSeconds(undefined)).toBeUndefined();
    expect(clampRetryAfterSeconds('')).toBeUndefined();
    expect(clampRetryAfterSeconds('soon')).toBeUndefined();
    expect(clampRetryAfterSeconds('0')).toBeUndefined();
    expect(clampRetryAfterSeconds('-30')).toBeUndefined();
    // HTTP-date form.
    expect(clampRetryAfterSeconds(new Date(Date.now() + 10_000).toUTCString())).toBeLessThanOrEqual(
      11,
    );
    expect(clampRetryAfterSeconds(new Date(Date.now() + 86_400_000).toUTCString())).toBe(60);
    expect(clampRetryAfterSeconds(new Date(Date.now() - 60_000).toUTCString())).toBeUndefined();
  });

  test('an upstream 429 with a 24-hour Retry-After is relayed as 60s', async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '86400' },
      });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  test('a short upstream Retry-After is relayed unchanged', async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '7' },
      });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
  });

  test('no Retry-After is invented when the upstream sent none', async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
  });

  test('a Retry-After on a terminal 400 is never relayed', async () => {
    const { hooks } = makeHooks({ resolveUpstream: async () => [managed] });
    const fetchImpl: FetchImpl = async () =>
      new Response('{"error":{"message":"bad request"}}', {
        status: 400,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      });

    const res = await createGateway(
      hooks,
      { retry: productionRetry },
      { fetchImpl },
    ).chatCompletions({ authorization: 'Bearer good', rawBody: chatBody });

    expect(res.status).toBe(400);
    expect(res.headers.get('retry-after')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 413 is terminal AND its body carries sizes. A byte count that merely contains
// "500" (e.g. 1500000) would make OpenCode re-upload an over-limit body five
// times, so the client-facing 413 message carries no digits at all — the exact
// sizes go to the gateway log instead.
// ---------------------------------------------------------------------------
describe('413 request_too_large is not retryable by OpenCode', () => {
  const TRIGGERING_SIZES = [1_500_000, 429_000, 502, 5_024_000, 503_000_000];

  test('the 413 message contains no digits, for any body size', () => {
    for (const bytes of TRIGGERING_SIZES) {
      // The message is a constant; assert it stays digit-free regardless of size.
      const message = 'Request body exceeds the configured maximum request size';
      expect(/\d/.test(message)).toBe(false);
      expect(OPENCODE_RETRY_STATUS_PATTERN.test(message)).toBe(false);
      expect(String(bytes)).not.toBe(message);
    }
  });

  test('both 413 sites emit that exact digit-free message', async () => {
    const chat = await Bun.file(
      new URL('./handler.ts', import.meta.url).pathname,
    ).text();
    const native = await Bun.file(
      new URL('./language-model-handler.ts', import.meta.url).pathname,
    ).text();
    const DIGIT_FREE = "message: 'Request body exceeds the configured maximum request size'";
    expect(chat).toContain(DIGIT_FREE);
    expect(native).toContain(DIGIT_FREE);
    // The old interpolated form must not come back.
    expect(chat).not.toContain('bytes exceeds the ${');
    expect(native).not.toContain('bytes exceeds the ${');
  });
});
