import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => captured.push(error),
  isSentryIgnoredError: () => false,
}));
const { installHttpErrors } = await import('../http-errors');

for (const [method, path, code, expected] of [
  ['GET', '/v1/projects/synthetic/gateway/overview', '57014', 503],
  ['GET', '/v1/projects/synthetic/gateway/series', '57014', 503],
  ['GET', '/v1/projects/synthetic/gateway/breakdown', '57014', 503],
  ['GET', '/v1/projects/synthetic/gateway/sessions', '57014', 503],
  ['GET', '/v1/projects/synthetic/gateway/overview', '42703', 500],
  ['POST', '/v1/projects/synthetic/gateway/overview', '57014', 500],
  ['GET', '/v1/projects/synthetic/sessions', '57014', 500],
] as const) {
  test(`${method} ${path} SQLSTATE ${code} returns ${expected}`, async () => {
    captured.length = 0;
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.on(method, path, () => {
      throw new Error('Failed query: select synthetic_private_column', {
        cause: Object.assign(new Error('canceling statement due to statement timeout'), {
          name: 'PostgresError', code, severity: 'ERROR',
        }),
      });
    });
    const response = await app.request(`${path}?days=90`, { method });
    expect(response.status).toBe(expected);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('synthetic_private_column');
    if (expected === 503) {
      expect(body).toEqual({ error: true, message: 'Gateway analytics are temporarily unavailable. Retry shortly.', status: 503, code: 'analytics_unavailable' });
      expect(response.headers.get('retry-after')).toBe('10');
      expect(captured).toHaveLength(0);
    } else {
      expect(body).toEqual({ error: true, message: 'Internal server error', status: 500 });
      expect(captured).toHaveLength(1);
    }
  });
}
