/**
 * A slow request's completion log line carries the per-stage Server-Timing
 * breakdown (`server_timing`), so a log-only latency investigation can attribute
 * the wall time to auth, database, or an outbound hop instead of guessing
 * (KRTX-532: the 2026-09-28/29 p95 rise on `GET /v1/projects/:id/sessions/:id`
 * could not be attributed from logs because the breakdown lived only in the
 * response header). A fast request carries no field.
 *
 * This drives the REAL global middleware chain (`installHttpMiddleware`) on a
 * bare app — the wiring under test is the inline post-request logger, which is
 * not exported. The single request context is opened around `app.fetch`
 * exactly as the server edge does.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The middleware chain mounts the audit boundary, whose synchronous test-env
// write needs a database this unit test does not own. Stub it: the boundary's
// behavior is covered by the audit suites; this test needs only the chain.
const realAudit = await import('../shared/audit');
mock.module('../shared/audit', () => ({
  ...realAudit,
  auditApiRequest: async (_c: unknown, next: () => Promise<unknown>) => next(),
}));

describe('the completion log line of a slow request', () => {
  test('carries server_timing; a fast request does not', async () => {
    const { installHttpMiddleware } = await import('../http-middleware');
    const { runWithContext } = await import('../lib/request-context');
    const { timeStage } = await import('../lib/server-timing');

    const lines: string[] = [];
    // The app logger writes info lines through `console.log`
    // (lib/logger.ts), so that is the seam this test captures.
    const original = { log: console.log, info: console.info, warn: console.warn };
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.info = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      const app = new OpenAPIHono();
      installHttpMiddleware(app);
      app.get('/slow', async (c) => {
        await timeStage('db', () => sleep(400));
        await timeStage('db', () => sleep(400));
        await timeStage('http', () => sleep(400));
        return c.json({ ok: true });
      });
      app.get('/fast', (c) => c.json({ ok: true }));
      const env = {
        fetch: (request: Request): Promise<Response> =>
          runWithContext(request.method, new URL(request.url).pathname, () =>
            app.fetch(request),
          ) as Promise<Response>,
      };
      await env.fetch(new Request('http://local/slow'));
      await env.fetch(new Request('http://local/fast'));
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
    }

    const completed = lines
      .filter((line) => line.includes('Request completed'))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>);
    const slow = completed.find((fields) => fields.server_timing !== undefined);
    expect(slow).toBeDefined();
    expect(String(slow?.server_timing)).toMatch(/^db;dur=\d+;desc="n=2", http;dur=\d+;desc="n=1"$/);
    expect(
      completed.some(
        (fields) => fields.server_timing === undefined && Number(fields.duration) < 1_000,
      ),
    ).toBe(true);
  });
});
