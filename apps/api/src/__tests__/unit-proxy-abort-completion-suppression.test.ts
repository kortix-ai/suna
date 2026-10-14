/**
 * The sandbox-proxy `Request completed:` line is suppressed for the daemon's
 * designed boot-phase 503 (`runtime_not_ready`) on the session-abort verb
 * (KRTX-2277): prod, 2026-10-14, one wedged sandbox produced 22 such 503s on
 * `POST /v1/p/:id/:id/session/:id/abort` in 40 minutes and the log sweep
 * counted every one as a route 5xx. The suppression keys on the attribution
 * headers the proxy sets (forward/retry.ts) — so this test drives the REAL
 * global middleware chain (`installHttpMiddleware`) on a bare app with routes
 * that answer in that exact shape, and asserts the line is (not) emitted. A
 * mutation that is not the abort verb keeps its line.
 *
 * Same seam as unit-slow-request-stage-log.test.ts: the inline post-request
 * logger is not exported, so the test captures the console the app logger
 * writes through. The capture is installed at module top — before anything
 * imports lib/logger — because the logger binds `originalConsoleWarn` at load
 * and warn lines (every 5xx) go through that binding, not the live console.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: string[] = [];
const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const push = (...args: unknown[]) => captured.push(args.map(String).join(' '));
console.log = push;
console.info = push;
console.warn = push;
console.error = push;

// The middleware chain mounts the audit boundary, whose synchronous test-env
// write needs a database this unit test does not own. Stub it: the boundary's
// behavior is covered by the audit suites; this test needs only the chain.
const realAudit = await import('../middleware/audit');
mock.module('../middleware/audit', () => ({
  ...realAudit,
  auditApiRequest: async (_c: unknown, next: () => Promise<unknown>) => next(),
}));

/** The daemon's designed boot-phase 503, attributed exactly as retry.ts does. */
function notReadyResponse(): Response {
  return new Response(JSON.stringify({ code: 'runtime_not_ready', detail: 'opencode' }), {
    status: 503,
    headers: {
      'content-type': 'application/json',
      'x-kortix-proxy-hop': 'daemon',
      'x-kortix-upstream-status': '503',
    },
  });
}

describe('the completion line of a daemon not-ready 503 on the sandbox proxy', () => {
  test('the abort verb is suppressed; other mutations still log', async () => {
    const { installHttpMiddleware } = await import('../http-middleware');
    const { runWithContext } = await import('../lib/request-context');
    try {
      const app = new OpenAPIHono();
      installHttpMiddleware(app);
      app.post('/v1/p/:sandboxId/:port/*', notReadyResponse);
      app.post('/v1/p/:sandboxId/:port', notReadyResponse);
      const env = {
        fetch: (request: Request): Promise<Response> =>
          runWithContext(request.method, new URL(request.url).pathname, () =>
            app.fetch(request),
          ) as Promise<Response>,
      };
      // The Stop press during the boot window: the designed pass-through.
      await env.fetch(
        new Request('http://local/v1/p/<sandbox>/8000/session/<session>/abort', { method: 'POST' }),
      );
      // A message that 503s was not delivered — the line stays.
      await env.fetch(
        new Request('http://local/v1/p/<sandbox>/8000/session/<session>/message', { method: 'POST' }),
      );
    } finally {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
    }

    const raw = captured.filter((line) => line.includes('Request completed'));
    expect(raw).toHaveLength(1);
    // The surviving line is the message mutation, not the abort.
    expect(raw[0]).toContain('POST /v1/p/<sandbox>/8000/session/<session>/message 503');
    const completed = raw.map(
      (line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>,
    );
    expect(String(completed[0]?.status)).toBe('503');
    expect(String(completed[0]?.proxy_hop)).toBe('daemon');
    expect(String(completed[0]?.upstream_status)).toBe('503');
  });
});
