import { describe, expect, test } from 'bun:test';
import { proxyAttemptTimeoutMs } from '../sandbox-proxy/preview-retry-budget';

describe('proxyAttemptTimeoutMs', () => {
  test('uses the full per-attempt timeout when budget is ample', () => {
    expect(proxyAttemptTimeoutMs(50_000)).toBe(15_000);
    expect(proxyAttemptTimeoutMs(15_000)).toBe(15_000);
  });

  test('shrinks the attempt to whatever budget remains', () => {
    expect(proxyAttemptTimeoutMs(10_000)).toBe(10_000);
    expect(proxyAttemptTimeoutMs(2_500)).toBe(2_500);
  });

  test('never drops below a 1s floor so the last attempt still gets a chance', () => {
    expect(proxyAttemptTimeoutMs(800)).toBe(1_000);
    expect(proxyAttemptTimeoutMs(0)).toBe(1_000);
    expect(proxyAttemptTimeoutMs(-5_000)).toBe(1_000);
  });

  test('a full 4-attempt run of capped attempts stays under the 60s ALB idle cut', () => {
    const BUDGET = 50_000;
    const DELAYS = [250, 1_000, 3_000]; // RETRY_DELAYS_MS between attempts
    let elapsed = 0;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const remaining = BUDGET - elapsed;
      if (remaining <= 500) break;
      elapsed += proxyAttemptTimeoutMs(remaining); // worst case: attempt hangs full timeout
      if (attempt < 3) elapsed += DELAYS[attempt];
    }
    expect(elapsed).toBeLessThan(55_000);
  });
});
