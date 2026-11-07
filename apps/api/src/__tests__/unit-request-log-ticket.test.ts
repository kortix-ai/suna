/**
 * The completion log line of a request to an Artifact's live socket path
 * never carries its `?ticket=` value (KRTX-3669): URLs land in log storage, and
 * a ticket is a credential for 60 s. Drives the REAL global middleware chain
 * on a bare app, as `unit-slow-request-stage-log.test.ts` does.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const realAudit = await import('../middleware/audit');
mock.module('../middleware/audit', () => ({
  ...realAudit,
  auditApiRequest: async (_c: unknown, next: () => Promise<unknown>) => next(),
}));

const TICKET = 'c2VhbGVkLXRpY2tldC12YWx1ZS1mb3ItdGhlLWxvZy10ZXN0';

describe('the completion log line of a live socket request', () => {
  test('names the route and carries no ticket value', async () => {
    const { installHttpMiddleware } = await import('../http-middleware');
    const { runWithContext } = await import('../lib/request-context');
    const lines: string[] = [];
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const write = process.stdout.write;
    const capture = (...args: unknown[]) => lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    console.log = capture;
    console.info = capture;
    console.warn = capture;
    console.error = capture;
    // The Hono access lines (`<--`, `-->`) go straight to stdout.
    process.stdout.write = ((chunk: unknown) => { capture(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const app = new OpenAPIHono();
      installHttpMiddleware(app);
      app.get('/v1/projects/:projectId/artifacts/:artifactId/live', (c) => c.json({ code: 'websocket_required' }, 426));
      const url = `http://local/v1/projects/p/artifacts/a/live?ticket=${TICKET}`;
      await runWithContext('GET', new URL(url).pathname, () => app.fetch(new Request(url)));
    } finally {
      Object.assign(console, original);
      process.stdout.write = write;
    }
    const completed = lines.filter((line) => line.includes('Request completed'));
    expect(completed.length).toBe(1);
    expect(completed[0]).toContain('GET /v1/projects/p/artifacts/a/live 426');
    expect(lines.some((line) => line.includes('--> GET /v1/projects/p/artifacts/a/live?ticket=<redacted>'))).toBe(true);
    expect(lines.filter((line) => line.includes(TICKET))).toEqual([]);
  });
});
