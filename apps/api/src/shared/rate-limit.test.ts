import { describe, expect, test } from 'bun:test';

import { TokenBucketRateLimiter } from './rate-limit';

describe('TokenBucketRateLimiter bounded buckets', () => {
  test('a flood of unique keys never grows the internal Map without bound', () => {
    const limiter = new TokenBucketRateLimiter('test');
    const policy = { limit: 60, windowMs: 60_000 };
    for (let i = 0; i < 120_000; i++) {
      limiter.check(`unique-key-${i}`, policy);
    }
    const size = (limiter as unknown as { buckets: Map<string, unknown> }).buckets.size;
    expect(size).toBeLessThanOrEqual(50_000);
  });

  test('a stable key keeps its bucket across checks (rate limiting still works)', () => {
    const limiter = new TokenBucketRateLimiter('test');
    const policy = { limit: 3, windowMs: 60_000 };
    expect(limiter.check('same', policy).allowed).toBe(true);
    expect(limiter.check('same', policy).allowed).toBe(true);
    expect(limiter.check('same', policy).allowed).toBe(true);
    expect(limiter.check('same', policy).allowed).toBe(false);
  });
});
