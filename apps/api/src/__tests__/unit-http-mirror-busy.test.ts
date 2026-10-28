import { expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => captured.push(error),
  isSentryIgnoredError: () => false,
}));
const { installHttpErrors } = await import('../http-errors');
const { GitOperationError } = await import('../projects/git/mirror');

test('mirror contention is retryable and non-paging, even through a grant wrapper', async () => {
  const app = new OpenAPIHono();
  installHttpErrors(app);
  app.get('/busy', () => {
    throw new Error('Grant refresh failed', { cause: new GitOperationError({
      kind: 'busy', message: 'Project mirror changed repeatedly during refresh', gitArgs: [],
    }) });
  });
  const response = await app.request('/busy');
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('10');
  expect(await response.json()).toEqual({
    error: true, code: 'git_mirror_unavailable', message: 'git mirror is temporarily unavailable', status: 503,
  });
  expect(captured).toHaveLength(0);
});

test('a generic error with the same text remains a paging failure', async () => {
  const app = new OpenAPIHono();
  installHttpErrors(app);
  app.get('/failure', () => { throw new Error('Project mirror changed repeatedly during refresh'); });
  const response = await app.request('/failure');
  expect(response.status).toBe(500);
  expect(captured).toHaveLength(1);
});
