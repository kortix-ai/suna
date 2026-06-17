import { describe, expect, test } from 'bun:test';

import {
  CircuitBreaker,
  backoffDelay,
  withResilience,
  withRetry,
  type RetryOptions,
} from './index';
import {
  CircuitOpenError,
  NetworkError,
  TimeoutError,
  UpstreamHttpError,
} from '../errors';

const noSleep = async () => {};
const fixedRand = () => 0.5;

function fastOpts(over: Partial<RetryOptions> = {}): RetryOptions {
  return { sleep: noSleep, rand: fixedRand, baseDelayMs: 10, ...over };
}

describe('backoffDelay', () => {
  test('exponential without jitter', () => {
    expect(backoffDelay(1, 100, 10_000, false, fixedRand)).toBe(100);
    expect(backoffDelay(2, 100, 10_000, false, fixedRand)).toBe(200);
    expect(backoffDelay(3, 100, 10_000, false, fixedRand)).toBe(400);
  });
  test('caps at maxMs', () => {
    expect(backoffDelay(10, 100, 1_000, false, fixedRand)).toBe(1_000);
  });
  test('equal jitter keeps a floor of half the exponential', () => {
    expect(backoffDelay(1, 100, 10_000, true, () => 0)).toBe(50);
    expect(backoffDelay(1, 100, 10_000, true, () => 1)).toBe(100);
  });
});

describe('withRetry', () => {
  test('returns on first success', async () => {
    let calls = 0;
    const r = await withRetry(async () => { calls++; return 'ok'; }, fastOpts());
    expect(r).toBe('ok');
    expect(calls).toBe(1);
  });

  test('retries a 5xx then succeeds', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new UpstreamHttpError(503, 'down');
      return 'recovered';
    }, fastOpts({ maxAttempts: 3 }));
    expect(r).toBe('recovered');
    expect(calls).toBe(3);
  });

  test('retries network errors when the provider is down', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new NetworkError('ECONNRESET');
      return 'up';
    }, fastOpts());
    expect(r).toBe('up');
    expect(calls).toBe(2);
  });

  test('does not retry a 4xx', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new UpstreamHttpError(400, 'bad'); }, fastOpts()),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(calls).toBe(1);
  });

  test('retries 429 rate-limit', async () => {
    let calls = 0;
    const r = await withRetry(async () => {
      calls++;
      if (calls < 2) throw new UpstreamHttpError(429, 'slow down');
      return 'ok';
    }, fastOpts());
    expect(calls).toBe(2);
    expect(r).toBe('ok');
  });

  test('exhausts maxAttempts then throws the last error', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new UpstreamHttpError(500, 'boom'); }, fastOpts({ maxAttempts: 3 })),
    ).rejects.toBeInstanceOf(UpstreamHttpError);
    expect(calls).toBe(3);
  });

  test('per-attempt timeout fires and is retryable', async () => {
    let calls = 0;
    const r = await withRetry(async (signal) => {
      calls++;
      if (calls === 1) {
        return await new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return 'second-ok';
    }, fastOpts({ timeoutMs: 5, maxAttempts: 2 }));
    expect(r).toBe('second-ok');
    expect(calls).toBe(2);
  });

  test('aborts the attempt signal on timeout', async () => {
    let aborted = false;
    await expect(
      withRetry(async (signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return await new Promise<string>(() => {});
      }, fastOpts({ timeoutMs: 5, maxAttempts: 1 })),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });

  test('reports each retry through onRetry', async () => {
    const seen: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      calls++;
      if (calls < 3) throw new UpstreamHttpError(500, 'x');
      return 'ok';
    }, fastOpts({ maxAttempts: 3, onRetry: ({ attempt }) => seen.push(attempt) }));
    expect(seen).toEqual([1, 2]);
  });
});

describe('CircuitBreaker', () => {
  test('opens after threshold consecutive failures, then fails fast', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 100, now: () => t });
    expect(cb.canRequest()).toBe(true);
    cb.onFailure(); cb.onFailure();
    expect(cb.current).toBe('closed');
    cb.onFailure();
    expect(cb.current).toBe('open');
    expect(cb.canRequest()).toBe(false);
  });

  test('a success resets the failure count', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.onFailure(); cb.onFailure();
    cb.onSuccess();
    cb.onFailure(); cb.onFailure();
    expect(cb.current).toBe('closed');
  });

  test('half-opens after cooldown and a success closes it', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    cb.onFailure();
    expect(cb.canRequest()).toBe(false);
    t = 100;
    expect(cb.canRequest()).toBe(true);
    expect(cb.current).toBe('half-open');
    cb.onSuccess();
    expect(cb.current).toBe('closed');
  });

  test('a half-open failure re-opens immediately', () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    cb.onFailure();
    t = 100;
    cb.canRequest();
    cb.onFailure();
    expect(cb.current).toBe('open');
    expect(cb.canRequest()).toBe(false);
  });
});

describe('withResilience', () => {
  test('fails fast with CircuitOpenError when the circuit is open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    cb.onFailure();
    let calls = 0;
    await expect(
      withResilience(async () => { calls++; return 'x'; }, fastOpts(), { provider: 'openrouter', breaker: cb }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(0);
  });

  test('a fully-failed retried call counts as one breaker failure', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });
    const run = () =>
      withResilience(async () => { throw new UpstreamHttpError(500, 'down'); }, fastOpts({ maxAttempts: 3 }), {
        provider: 'p',
        breaker: cb,
      }).catch(() => {});
    await run();
    expect(cb.current).toBe('closed');
    await run();
    expect(cb.current).toBe('open');
  });

  test('a success closes a half-open breaker', async () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    await withResilience(async () => { throw new NetworkError(); }, fastOpts({ maxAttempts: 1 }), {
      provider: 'p', breaker: cb,
    }).catch(() => {});
    expect(cb.current).toBe('open');
    t = 100;
    const r = await withResilience(async () => 'ok', fastOpts(), { provider: 'p', breaker: cb });
    expect(r).toBe('ok');
    expect(cb.current).toBe('closed');
  });
});
