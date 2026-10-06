import { describe, expect, test } from 'bun:test';

import { clientIp, consumeRateLimit } from './rate-limit';

describe('rate limiter', () => {
  test('keys on the proxy-appended address, not the client-supplied one', () => {
    const req = (h: Record<string, string>) => new Request('http://x', { headers: h });
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed, 198.51.100.7' }))).toBe('198.51.100.7');
    expect(clientIp(req({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': 'spoofed' }))).toBe('198.51.100.8');
  });

  test('stays under 10k buckets however many keys arrive', () => {
    const now = 1_000;
    for (let i = 0; i < 10_500; i++) consumeRateLimit(`k${i}`, 5, now);
    // The oldest keys were evicted, so they start a fresh count.
    expect(consumeRateLimit('k0', 1, now).remaining).toBe(0);
    expect(consumeRateLimit('k0', 1, now).allowed).toBe(false);
    const evicted = consumeRateLimit('k1', 1, now);
    expect(evicted.allowed).toBe(true);
  });
});
