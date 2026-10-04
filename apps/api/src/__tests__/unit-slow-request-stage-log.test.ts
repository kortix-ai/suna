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
import { logger as appLogger } from '../lib/logger';

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
    const { installHttpMiddleware } = await import('../middleware/http-middleware');
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

  test('a failed proxy request logs its hop but never its response body', async () => {
    const { installHttpMiddleware } = await import('../middleware/http-middleware');
    const { runWithContext } = await import('../lib/request-context');
    const lines: Array<Record<string, unknown>> = [];
    const original = appLogger.warn;
    appLogger.warn = (_message, fields) => lines.push(fields ?? {});
    try {
      const app = new OpenAPIHono();
      installHttpMiddleware(app);
      app.post('/v1/p/:id/:port/kortix/env-rpc', (c) =>
        c.json({ error: 'synthetic-sensitive-body' }, 503, {
          'X-Kortix-Proxy-Hop': 'provider_ingress',
          'X-Kortix-Upstream-Status': '503',
        }),
      );
      await runWithContext('POST', '/v1/p/synthetic/8000/kortix/env-rpc', () =>
        app.fetch(new Request('http://local/v1/p/synthetic/8000/kortix/env-rpc', { method: 'POST' })),
      );
    } finally {
      appLogger.warn = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]?.proxy_hop).toBe('provider_ingress');
    expect(lines[0]?.upstream_status).toBe('503');
    expect(JSON.stringify(lines)).not.toContain('synthetic-sensitive-body');
  });
});
