import { afterEach, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => captured.push(error),
  isSentryIgnoredError: () => false,
}));
mock.module('../config', () => ({ config: {
  PLATINUM_API_KEY: 'synthetic-key', PLATINUM_API_URL: 'http://provider.test',
  SANDBOX_PROVIDER: 'platinum',
} }));
const { platinumJson } = await import('../shared/platinum');
const { installHttpErrors } = await import('../http-errors');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; captured.length = 0; });

for (const scenario of [
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 504, expected: 504 },
  { method: 'GET', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 504, expected: 500 },
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/stop', upstream: 504, expected: 500 },
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 500, expected: 500 },
  { method: 'POST', path: '/v1/sandboxes/sbx_synthetic/exec', upstream: 403, expected: 500 },
]) {
  test(`${scenario.method} ${scenario.path} upstream ${scenario.upstream} returns ${scenario.expected} without replay`, async () => {
    let calls = 0;
    globalThis.fetch = Object.assign(async () => {
      calls++;
      return new Response('<!DOCTYPE html><title>Gateway Timeout</title>', { status: scenario.upstream });
    }, { preconnect: originalFetch.preconnect });
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/exec', async (c) => c.json(await platinumJson(scenario.path, { method: scenario.method })));
    const response = await app.request('/exec', { method: 'POST' });
    expect(response.status).toBe(scenario.expected);
    expect(calls).toBe(1);
    expect(captured.length).toBe(scenario.expected === 504 ? 0 : 1);
    if (scenario.expected === 504) {
      expect(await response.json()).toEqual({
        error: true, code: 'sandbox_exec_outcome_unknown', status: 504,
        message: 'The sandbox provider timed out. The command may have run; inspect its effects before running it again.',
      });
      expect(response.headers.get('retry-after')).toBeNull();
    }
  });
}
