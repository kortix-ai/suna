import { afterEach, describe, expect, test } from 'bun:test';
import { startFilesystemBlobSweeper, stopFilesystemBlobSweeper } from './blob-sweeper';

afterEach(() => stopFilesystemBlobSweeper());

const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('the blob sweeper schedule', () => {
  test('sweeps once on boot, so downtime does not defer reclamation a whole tick', async () => {
    let calls = 0;
    startFilesystemBlobSweeper({
      intervalMs: 60_000,
      sweep: async () => {
        calls += 1;
        return { scanned: 0, collected: 0, failed: 0 };
      },
    });
    await settle();
    expect(calls).toBe(1);
  });

  test('start is idempotent — a leadership flap must not arm two timers', async () => {
    let calls = 0;
    const sweep = async () => {
      calls += 1;
      return { scanned: 0, collected: 0, failed: 0 };
    };
    startFilesystemBlobSweeper({ intervalMs: 60_000, sweep });
    startFilesystemBlobSweeper({ intervalMs: 60_000, sweep });
    startFilesystemBlobSweeper({ intervalMs: 60_000, sweep });
    await settle();
    expect(calls).toBe(1);
  });

  /**
   * Re-arming only AFTER a tick settles is what keeps runs serial. With
   * setInterval a slow sweep would start the next one before the prior
   * finished, and two overlapping sweeps can each see the same blob as
   * unreferenced and both try to delete it.
   */
  test('a slow tick does not overlap the next one', async () => {
    let running = 0;
    let maxConcurrent = 0;
    startFilesystemBlobSweeper({
      intervalMs: 1,
      sweep: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await settle(15);
        running -= 1;
        return { scanned: 0, collected: 0, failed: 0 };
      },
    });
    await settle(80);
    expect(maxConcurrent).toBe(1);
  });

  test('a throwing sweep does not kill the schedule', async () => {
    let calls = 0;
    startFilesystemBlobSweeper({
      intervalMs: 1,
      sweep: async () => {
        calls += 1;
        throw new Error('database went away');
      },
    });
    await settle(40);
    // It kept ticking despite every tick failing — a transient database blip
    // must not silently disable reclamation until the next restart.
    expect(calls).toBeGreaterThan(1);
  });

  test('stop prevents any further tick', async () => {
    let calls = 0;
    startFilesystemBlobSweeper({
      intervalMs: 1,
      sweep: async () => {
        calls += 1;
        return { scanned: 0, collected: 0, failed: 0 };
      },
    });
    await settle(20);
    stopFilesystemBlobSweeper();
    const settled = calls;
    await settle(40);
    expect(calls).toBe(settled);
  });

  test('stop is safe when it was never started', () => {
    expect(() => stopFilesystemBlobSweeper()).not.toThrow();
  });
});
