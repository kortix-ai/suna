import { describe, expect, test } from 'bun:test';

import { CircuitOpenError, NetworkError, UpstreamHttpError } from '../errors';
import { CircuitBreaker, withResilience } from './circuit-breaker';

const noRetry = { maxAttempts: 1, sleep: async () => {} };

function binding(opts?: { failureThreshold?: number; cooldownMs?: number }) {
  return { provider: 'anthropic', breaker: new CircuitBreaker(opts) };
}

describe('withResilience — breaker tripping', () => {
  test('a 5xx trips the breaker', async () => {
    const b = binding({ failureThreshold: 1 });
    await expect(
      withResilience(
        async () => {
          throw new UpstreamHttpError(503, 'down', 'anthropic');
        },
        noRetry,
        b,
      ),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(b.breaker.current).toBe('open');
  });

  test('a network error trips the breaker', async () => {
    const b = binding({ failureThreshold: 1 });
    await expect(
      withResilience(
        async () => {
          throw new NetworkError('boom');
        },
        noRetry,
        b,
      ),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(b.breaker.current).toBe('open');
  });

  test('a 429 (per-credential rate limit) does NOT trip the shared breaker', async () => {
    const b = binding({ failureThreshold: 1 });
    for (let i = 0; i < 5; i += 1) {
      await expect(
        withResilience(
          async () => {
            throw new UpstreamHttpError(429, 'rate limit', 'anthropic');
          },
          noRetry,
          b,
        ),
      ).rejects.toBeInstanceOf(UpstreamHttpError);
    }
    expect(b.breaker.current).toBe('closed');
    expect(b.breaker.failureCount).toBe(0);
    // Breaker still closed → next caller is allowed through, not fast-failed.
    expect(b.breaker.canRequest()).toBe(true);
  });

  test('a 402/403 (quota/billing) does NOT trip the shared breaker', async () => {
    const b = binding({ failureThreshold: 1 });
    for (const status of [402, 403]) {
      await expect(
        withResilience(
          async () => {
            throw new UpstreamHttpError(status, 'nope', 'anthropic');
          },
          noRetry,
          b,
        ),
      ).rejects.toBeInstanceOf(UpstreamHttpError);
    }
    expect(b.breaker.current).toBe('closed');
  });

  test('an open breaker fast-fails with CircuitOpenError before calling fn', async () => {
    const b = binding({ failureThreshold: 1, cooldownMs: 10_000 });
    await expect(
      withResilience(
        async () => {
          throw new UpstreamHttpError(500, 'down', 'anthropic');
        },
        noRetry,
        b,
      ),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    let called = false;
    await expect(
      withResilience(
        async () => {
          called = true;
          return 'ok';
        },
        noRetry,
        b,
      ),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
  });
});
