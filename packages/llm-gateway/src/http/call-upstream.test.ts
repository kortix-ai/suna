import { describe, expect, test } from 'bun:test';

import { callUpstream, type FetchImpl } from './call-upstream';
import { buildUpstreamRequest } from '../transports';
import { CircuitBreaker } from '../resilience';
import { CircuitOpenError, UpstreamHttpError } from '../errors';
import type { UpstreamDescriptor } from '../domain';

const descriptor: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://up.test/v1',
  apiKey: 'sk-test',
  billingMode: 'credits',
  markup: 1.2,
};

const fastRetry = { sleep: async () => {}, rand: () => 0.5, baseDelayMs: 1, maxAttempts: 3 };

type Step = { status: number; body?: string } | { throw: string };

function makeFetch(steps: Step[]) {
  let calls = 0;
  const impl: FetchImpl = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    if ('throw' in step) throw new TypeError(step.throw);
    return new Response(step.body ?? '{}', {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, getCalls: () => calls };
}

describe('buildUpstreamRequest', () => {
  test('targets /chat/completions with a bearer key', () => {
    const req = buildUpstreamRequest({ model: 'x' }, descriptor);
    expect(req.url).toBe('https://up.test/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
  });
  test('trims a trailing slash on the base URL', () => {
    const req = buildUpstreamRequest({}, { ...descriptor, baseUrl: 'https://up.test/v1/' });
    expect(req.url).toBe('https://up.test/v1/chat/completions');
  });
});

describe('callUpstream', () => {
  test('retries a 503 then returns the ok response', async () => {
    const fetchMock = makeFetch([{ status: 503, body: 'down' }, { status: 200, body: '{"ok":true}' }]);
    const res = await callUpstream({ model: 'x' }, descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl });
    expect(res.status).toBe(200);
    expect(fetchMock.getCalls()).toBe(2);
  });

  test('retries a thrown network error (provider down)', async () => {
    const fetchMock = makeFetch([{ throw: 'ECONNREFUSED' }, { status: 200 }]);
    const res = await callUpstream({}, descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl });
    expect(res.status).toBe(200);
    expect(fetchMock.getCalls()).toBe(2);
  });

  test('does not retry a 400 and surfaces status + body', async () => {
    const fetchMock = makeFetch([{ status: 400, body: 'bad model' }]);
    try {
      await callUpstream({}, descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamHttpError);
      expect((err as UpstreamHttpError).status).toBe(400);
      expect((err as UpstreamHttpError).body).toBe('bad model');
    }
    expect(fetchMock.getCalls()).toBe(1);
  });

  test('opens the breaker and fails fast after repeated failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const fetchMock = makeFetch([{ status: 500, body: 'boom' }]);
    const binding = { provider: descriptor.provider, breaker };

    await callUpstream({}, descriptor, { retry: { ...fastRetry, maxAttempts: 1 }, fetchImpl: fetchMock.impl, binding }).catch(() => {});
    expect(breaker.current).toBe('open');

    const callsBefore = fetchMock.getCalls();
    await expect(
      callUpstream({}, descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl, binding }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock.getCalls()).toBe(callsBefore);
  });
});
