import { describe, expect, test } from 'bun:test';
import { tunnelRateLimiter } from './rate-limiter';

describe('tunnelRateLimiter', () => {
  test('a flood of throwaway keys evicts old buckets instead of refusing new keys', () => {
    for (let i = 0; i < 10_050; i++) tunnelRateLimiter.check('deviceAuthPoll', `flood-${i}`);
    expect(tunnelRateLimiter.check('deviceAuthPoll', 'fresh-caller').allowed).toBe(true);
  });

  test('a single key is still limited', () => {
    const results = Array.from({ length: 31 }, () => tunnelRateLimiter.check('deviceAuthPoll', 'one-key'));
    expect(results.slice(0, 30).every((r) => r.allowed)).toBe(true);
    expect(results[30]!.allowed).toBe(false);
  });

  test('the per-address poll bucket caps one address', () => {
    const results = Array.from({ length: 301 }, () => tunnelRateLimiter.check('deviceAuthPollIp', 'ip-a'));
    expect(results[299]!.allowed).toBe(true);
    expect(results[300]!.allowed).toBe(false);
    expect(tunnelRateLimiter.check('deviceAuthPollIp', 'ip-b').allowed).toBe(true);
  });
});
