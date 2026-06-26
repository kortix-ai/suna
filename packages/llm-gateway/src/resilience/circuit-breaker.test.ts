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

describe('CircuitBreaker — single-probe half-open gate', () => {
  test('half-open admits exactly one probe; concurrent callers fast-fail', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    b.onFailure(); // closed → open (threshold 1)
    expect(b.current).toBe('open');
    expect(b.canRequest()).toBe(false); // still in cooldown

    t = 100; // cooldown elapsed
    expect(b.canRequest()).toBe(true); // first probe claims the single slot → half-open
    expect(b.current).toBe('half-open');
    expect(b.canRequest()).toBe(false); // a second concurrent caller is rejected

    b.onSuccess(); // probe succeeded → closed, slot freed
    expect(b.current).toBe('closed');
    expect(b.canRequest()).toBe(true);
  });

  test('a failed half-open probe re-opens and re-arms the cooldown', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    b.onFailure();
    t = 100;
    expect(b.canRequest()).toBe(true); // probe
    b.onFailure(); // probe fails → re-open
    expect(b.current).toBe('open');
    expect(b.canRequest()).toBe(false); // back in cooldown, no probe yet
  });

  test('onProbeReleased frees the slot without closing (reachable-but-rejected)', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    b.onFailure();
    t = 100;
    expect(b.canRequest()).toBe(true); // probe 1 claims the slot
    expect(b.canRequest()).toBe(false); // slot taken
    b.onProbeReleased(); // e.g. a 429 reached the host → free slot, stay half-open
    expect(b.current).toBe('half-open');
    expect(b.canRequest()).toBe(true); // next probe allowed
  });
});

describe('CircuitBreaker — fleet-wide signal adoption', () => {
  test('a closed breaker adopts a fleet-wide open verdict and fails fast', () => {
    let t = 0;
    const b = new CircuitBreaker({ cooldownMs: 100, now: () => t }, 'bedrock', {
      isOpenFleetWide: (p) => p === 'bedrock',
    });
    // No local failures, but the shared store says bedrock is down fleet-wide.
    expect(b.canRequest()).toBe(false);
    expect(b.current).toBe('open');
    // After cooldown a single local probe is still admitted so recovery isn't blocked.
    t = 100;
    expect(b.canRequest()).toBe(true);
    expect(b.current).toBe('half-open');
  });

  test('a closed signal leaves a healthy breaker untouched', () => {
    const b = new CircuitBreaker({}, 'bedrock', { isOpenFleetWide: () => false });
    expect(b.canRequest()).toBe(true);
    expect(b.current).toBe('closed');
  });
});
