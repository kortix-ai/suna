import { expect, test } from 'bun:test';
import { UpstreamHttpError } from '../errors';
import { withRetry } from './retry';

test('control-plane retry retries one transient failure', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    if (calls === 1) throw new UpstreamHttpError(503, 'unavailable');
    return 'ok';
  }, { maxAttempts: 2, sleep: async () => {}, jitter: false });
  expect(result).toBe('ok');
  expect(calls).toBe(2);
});

test('control-plane retry does not retry a client error', async () => {
  let calls = 0;
  await expect(withRetry(async () => {
    calls += 1;
    throw new UpstreamHttpError(400, 'bad request');
  }, { maxAttempts: 3, sleep: async () => {} })).rejects.toThrow('upstream HTTP 400');
  expect(calls).toBe(1);
});
