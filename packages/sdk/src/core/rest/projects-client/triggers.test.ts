import { expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { fireProjectTrigger } from './triggers';

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'token' });

test('manual trigger fire forwards a stable retry key', async () => {
  let request: RequestInit | undefined;
  globalThis.fetch = mock(async (_url: unknown, options?: RequestInit) => {
    request = options;
    return new Response(JSON.stringify({ status: 'deduped', deduped: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  await fireProjectTrigger('project-1', 'trigger-1', { idempotencyKey: 'retry-1' });
  expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('retry-1');
});
