/**
 * Daytona support was removed on 2026-10-28. A stored session row may still
 * name `daytona`; getProvider() throws RemovedProviderError for it. The HTTP
 * error handler answers 410 `sandbox_provider_removed` with a message the UI
 * shows, and sends no Sentry event: it is expected legacy data, not a bug.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => captured.push(error),
  isSentryIgnoredError: () => false,
}));

const { installHttpErrors } = await import('../http-errors');
const { RemovedProviderError } = await import('../platform/providers/deprecated');

describe('RemovedProviderError at the HTTP error handler', () => {
  test('answers 410 sandbox_provider_removed with the removal message, no Sentry event', async () => {
    captured.length = 0;
    const server = new OpenAPIHono();
    installHttpErrors(server);
    server.post('/v1/projects/:projectId/sessions/:sessionId/start', () => {
      throw new RemovedProviderError('daytona');
    });

    const res = await server.request('/v1/projects/p-1/sessions/s-1/start', { method: 'POST' });

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toMatchObject({ error: true, code: 'sandbox_provider_removed', status: 410 });
    expect(body.message).toContain('Daytona support was removed');
    expect(captured).toHaveLength(0);
  });
});
