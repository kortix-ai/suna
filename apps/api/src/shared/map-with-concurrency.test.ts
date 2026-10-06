import { describe, expect, test } from 'bun:test';
import { mapWithConcurrency } from './map-with-concurrency';

describe('mapWithConcurrency', () => {
  test('keeps input order and the concurrency bound', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });

  test('a rejection waits for the other workers and starts no new item', async () => {
    const started: number[] = [];
    let slowDone = false;
    const run = mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('boom');
      await Bun.sleep(30);
      if (n === 2) slowDone = true;
    });
    await expect(run).rejects.toThrow('boom');
    // The call settled only after the in-flight worker finished.
    expect(slowDone).toBe(true);
    expect(started).toEqual([1, 2]);
  });
});
