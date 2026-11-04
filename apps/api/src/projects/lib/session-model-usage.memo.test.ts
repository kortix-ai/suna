import { describe, expect, test } from 'bun:test';

import { createProjectSpendByModel } from './session-model-usage';

type Rows = Awaited<ReturnType<Parameters<typeof createProjectSpendByModel>[0] & {}>>;
const rows = (requests: number): Rows => [
  {
    estimated_usage_value: null, priced_requests: 0, unpriced_requests: 0, model: 'm', provider: 'kortix',
    requests, errors: 0, cost: 0, kortix_cost: 0, provider_cost: 0, tokens: 0,
  },
];

describe('projectSpendByModel memo', () => {
  test('a burst of identical dashboard reads runs one aggregate', async () => {
    let calls = 0;
    const spend = createProjectSpendByModel(async () => {
      calls++;
      await Bun.sleep(10);
      return rows(1);
    }, true);
    const results = await Promise.all([spend('p1', 30), spend('p1', 30), spend('p1', 30)]);
    expect(calls).toBe(1);
    expect(results.map((r) => r[0]?.requests)).toEqual([1, 1, 1]);
    await spend('p1', 30);
    expect(calls).toBe(1);
  });

  test('a different project or window is its own aggregate', async () => {
    let calls = 0;
    const spend = createProjectSpendByModel(async () => rows(++calls), true);
    await spend('p1', 30);
    await spend('p1', 7);
    await spend('p2', 30);
    expect(calls).toBe(3);
  });

  test('a failed aggregate is not cached', async () => {
    let calls = 0;
    const spend = createProjectSpendByModel(async () => {
      if (++calls === 1) throw new Error('canceling statement due to statement timeout');
      return rows(5);
    }, true);
    await expect(spend('p1', 30)).rejects.toThrow('statement timeout');
    expect((await spend('p1', 30))[0]?.requests).toBe(5);
    expect(calls).toBe(2);
  });
});
