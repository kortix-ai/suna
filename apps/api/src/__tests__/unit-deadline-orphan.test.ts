/**
 * An orphaned handler continuation after the request deadline must be
 * classified, not captured (KRTX-2583).
 *
 * Hono's `timeout` middleware races the handler against a timer; when the
 * timer wins, the 503 (Retry-After) is served while the handler keeps running
 * with no owner. When that orphan later resumes — prod 2026-10-16 22:43:05,
 * request mvbjzd4t-a8d: GET /v1/runtime-assets/manifest spent 31.9s under a
 * stalled DB pool — its first context touch (`c.header('Cache-Control',
 * 'no-cache')`) makes Hono recreate the already sent Response from its
 * now-consumed body stream, and Bun rejects that with
 * `TypeError: Body object should not be disturbed or locked`. compose catches
 * at every dispatch level and calls onError a second time, which captured the
 * TypeError to Sentry (Better Stack pattern 235fd74b…) even though the client
 * already had the designed, retryable 503.
 *
 * These tests reproduce that exact sequence against the real pieces (hono's
 * `timeout` race, the real onError, a real served-and-consumed response) and
 * pin the fix: the deadline marks the context when it fires, and
 * handleUnhandledError classifies any later error from that context as a
 * deadline orphan — warn log, no Sentry capture, 503 — while every other
 * error keeps its existing classification.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Context } from 'hono';
import { timeout } from 'hono/timeout';

const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown, context?: Record<string, unknown>) => {
    captured.push({ error, context });
  },
  isSentryIgnoredError: () => false,
}));

const { installHttpErrors } = await import('../http-errors');
const {
  DEADLINE_SERVED_VAR,
  isDeadlineOrphan,
  markDeadlineServed,
  RequestDeadlineHTTPException,
} = await import('../middleware/request-deadline');

const ORPHAN_503_MESSAGE = 'Request deadline already exceeded';

function appWith(handler: (c: Context) => Promise<Response>): {
  server: OpenAPIHono;
  requestContext: () => Context;
} {
  const server = new OpenAPIHono();
  installHttpErrors(server);
  let held: Context | undefined;
  server.use('*', (c, next) => {
    held = c;
    return next();
  });
  // The prod middleware bounds at 25 s; the race itself is hono's `timeout`
  // with the same exception factory in both cases, so a 30 ms bound exercises
  // the same code path.
  server.use('*', timeout(30, markDeadlineServed));
  server.get('/v1/runtime-assets/manifest', handler);
  return { server, requestContext: () => held! };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('deadline orphan classification (KRTX-2583)', () => {
  test('an orphaned handler after the deadline is classified 503 without capture', async () => {
    captured.length = 0;
    const { server, requestContext } = appWith(async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      c.header('Cache-Control', 'no-cache');
      return c.json({ ok: true });
    });

    const res = await server.request('/v1/runtime-assets/manifest');
    // The designed deadline response reached the client before the handler
    // resumed.
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('10');
    const ctx = requestContext();
    const servedResponse = ctx.res;
    expect(await servedResponse.clone().json()).toEqual({
      error: true,
      message: expect.stringContaining('server processing deadline'),
      status: 503,
      code: 'request_deadline',
    });

    // Bun.serve writes the response body to the socket: consume it, exactly
    // what production does when it sends the 503.
    await servedResponse.text();

    // The orphan resumes, touches `c.header` on the served context, and its
    // error must be classified (503, no capture) — not a captured 500.
    await waitFor(() => ctx.res !== servedResponse);
    expect(await ctx.res.json()).toEqual({
      error: true,
      message: ORPHAN_503_MESSAGE,
      status: 503,
      code: 'request_deadline',
    });
    expect(captured).toHaveLength(0);
  });

  test('an error before the deadline keeps its existing 500 and capture', async () => {
    captured.length = 0;
    const { server } = appWith(async () => {
      throw new TypeError('boom');
    });
    const res = await server.request('/v1/runtime-assets/manifest');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: true, message: 'Internal server error', status: 500 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.error).toBeInstanceOf(TypeError);
    expect((captured[0]?.context as Record<string, unknown>).errorType).toBe('TypeError');
  });
});

describe('isDeadlineOrphan', () => {
  test('false while the deadline has not fired', () => {
    const c = new Context(new Request('http://localhost/v1/x'));
    expect(isDeadlineOrphan(c, new TypeError('Body object should not be disturbed or locked'))).toBe(false);
  });

  test('false for the deadline exception itself — the normal 503 path', () => {
    const c = new Context(new Request('http://localhost/v1/x'));
    c.set(DEADLINE_SERVED_VAR, true);
    expect(isDeadlineOrphan(c, new RequestDeadlineHTTPException())).toBe(false);
  });

  test('true once the deadline fired and a non-deadline error arrives', () => {
    const c = new Context(new Request('http://localhost/v1/x'));
    c.set(DEADLINE_SERVED_VAR, true);
    expect(isDeadlineOrphan(c, new TypeError('Body object should not be disturbed or locked'))).toBe(true);
  });
});
