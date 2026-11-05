import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../config';
import { __resetPlatinumWriteLaneForTests, awaitPlatinumWriteSlot, inPlatinumBackgroundLane } from '../shared/platinum-write-lane';

/** A fake clock: `sleep` advances it, so no test waits on real time. */
function clock(start = 1_000_000) {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    slept,
  };
}

const PER_SECOND = config.KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND;
afterEach(() => {
  config.KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND = PER_SECOND;
  __resetPlatinumWriteLaneForTests();
});

describe('the Platinum background write lane', () => {
  test('writes inside the lane leave at most N per second; the first goes at once', async () => {
    config.KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND = 8;
    const c = clock();
    const at: number[] = [];
    await inPlatinumBackgroundLane(async () => {
      for (const method of ['POST', 'POST', 'DELETE', 'PUT']) {
        await awaitPlatinumWriteSlot(method, c.now(), c.sleep);
        at.push(c.now());
      }
    });
    expect(at.map((t) => t - 1_000_000)).toEqual([0, 125, 250, 375]);
  });

  test('a read in the lane, and any call outside it, is never delayed', async () => {
    config.KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND = 8;
    const c = clock();
    await inPlatinumBackgroundLane(async () => {
      await awaitPlatinumWriteSlot('POST', c.now(), c.sleep);
      await awaitPlatinumWriteSlot('GET', c.now(), c.sleep);
      await awaitPlatinumWriteSlot('HEAD', c.now(), c.sleep);
    });
    // A session start outside the lane, in the same instant as the lane's next slot.
    await awaitPlatinumWriteSlot('POST', c.now(), c.sleep);
    expect(c.slept).toEqual([]);
  });

  test('the lane follows async work it starts, and 0 turns the pacing off', async () => {
    config.KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND = 4;
    const c = clock();
    await inPlatinumBackgroundLane(async () => {
      await Promise.all([1, 2, 3].map(async () => {
        await Promise.resolve();
        await awaitPlatinumWriteSlot('POST', c.now(), c.sleep);
      }));
    });
    expect(c.slept.length).toBe(2);
    config.KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND = 0;
    const off = clock();
    await inPlatinumBackgroundLane(async () => {
      for (let i = 0; i < 3; i++) await awaitPlatinumWriteSlot('POST', off.now(), off.sleep);
    });
    expect(off.slept).toEqual([]);
  });
});
