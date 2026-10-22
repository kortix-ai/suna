import { describe, expect, test } from 'bun:test';
import { createLastUsedTracker } from './throttled-last-used';

describe('last-used tracker', () => {
  test('throttles each id independently and sweeps stale entries after 1000 ids', async () => {
    const writes: string[] = [];
    const touch = createLastUsedTracker(async (id) => { writes.push(id); });
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      await touch('first');
      await touch('first');
      expect(writes).toEqual(['first']);
      now += 15 * 60 * 1000 - 1;
      await touch('first');
      expect(writes).toEqual(['first']);
      now += 1;
      await touch('first');
      expect(writes).toEqual(['first', 'first']);
      now += 30 * 60 * 1000 + 1;
      for (let i = 0; i < 1001; i++) await touch(`id-${i}`);
      await touch('first');
      expect(writes.filter((id) => id === 'first')).toHaveLength(3);
    } finally {
      Date.now = originalNow;
    }
  });

  test('swallows a failed write without blocking subsequent touches', async () => {
    const touch = createLastUsedTracker(async () => { throw new Error('write failed'); });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await expect(touch('id')).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
  });
});
