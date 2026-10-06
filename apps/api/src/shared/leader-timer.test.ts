import { describe, expect, mock, test } from 'bun:test';

let leader = true;
mock.module('./leader-election', () => ({ isLeader: () => leader }));
const { leaderTimer } = await import('./leader-timer');

describe('leaderTimer', () => {
  test('a stop then start while a tick runs leaves one chain, not two', async () => {
    leader = true;
    let ticks = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = leaderTimer(async () => {
      ticks += 1;
      if (ticks === 1) await gate;
      return 20;
    });
    timer.start();
    timer.stop();
    timer.start();
    release();
    await Bun.sleep(130);
    timer.stop();
    // One chain at ~20 ms spacing gives about 6 ticks. Two chains give about 12.
    expect(ticks).toBeLessThan(9);
  });

  test('a tick runs nothing once the lease is gone', async () => {
    leader = false;
    let ticks = 0;
    const timer = leaderTimer(async () => {
      ticks += 1;
      return 10;
    });
    timer.start();
    await Bun.sleep(40);
    timer.stop();
    expect(ticks).toBe(0);
  });

  test('stop ends the chain', async () => {
    leader = true;
    let ticks = 0;
    const timer = leaderTimer(async () => {
      ticks += 1;
      return 10;
    });
    timer.start();
    await Bun.sleep(35);
    timer.stop();
    const seen = ticks;
    await Bun.sleep(40);
    expect(ticks).toBe(seen);
  });
});
