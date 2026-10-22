import { describe, expect, test } from 'bun:test';
import { compare, measure } from './compare-web-latency.mjs';

describe('web latency comparison', () => {
  test('computes nearest-rank percentiles after reading each response body', async () => {
    const fetcher = async () => Response.json({ ok: true });
    const result = await measure('https://example.test/api/health', 4, fetcher);
    expect(result.p75).toBeGreaterThanOrEqual(0);
    expect(result.p95).toBeGreaterThanOrEqual(result.p75);
  });

  test('rejects a slow candidate on either percentile and HTTP failures', async () => {
    expect(compare({ p75: 100, p95: 200 }, { p75: 121, p95: 200 })).toBe(false);
    expect(compare({ p75: 100, p95: 200 }, { p75: 100, p95: 241 })).toBe(false);
    expect(compare({ p75: 100, p95: 200 }, { p75: 119, p95: 239 })).toBe(true);
    await expect(measure('https://example.test/', 1, async () => new Response('', { status: 503 }))).rejects.toThrow('HTTP 503');
  });
});
