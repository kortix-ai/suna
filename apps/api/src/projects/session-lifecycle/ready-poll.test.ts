// HOW LONG A QUEUED PROMPT WAITS AFTER ITS RUNTIME IS READY.
//
// The delivery loop rechecks `stage` until the runtime is ready. That recheck
// was a flat 3 s, so a prompt queued during provisioning waited on average half
// a poll after the runtime came up — for nothing, since it had been ready the
// whole time.
//
// MEASURED on dev 2026-09-08, one session split across three clocks (the
// client, the API's provision-timeline, and the cell's own turns table):
//
//   client: POST /sessions -> returns              1639 ms
//   client: -> session reports ready               2861 ms
//   cell:   ready -> prompt lands in the cell      1415 ms   <- this
//   cell:   prompt lands -> turn starts               7 ms
//   cell:   turn runs                              1547 ms
//
// 1415 ms of dead wait: longer than the model call it was waiting to make, and
// two hundred times the cell's own share of the turn.
import { describe, expect, test } from 'bun:test';
import { READY_POLL_MAX_MS, READY_POLL_MIN_MS, nextReadyPollMs } from './ready-poll';

/** The loop itself: check, sleep, check again. Answers when it would notice a
 *  runtime that became ready at `readyAtMs`. */
const noticedAt = (readyAtMs: number, mode: 'flat' | 'backoff'): number => {
  let t = 0;
  let wait = mode === 'flat' ? READY_POLL_MAX_MS : READY_POLL_MIN_MS;
  for (let i = 0; i < 2_000; i++) {
    if (t >= readyAtMs) return t;
    t += wait;
    if (mode === 'backoff') wait = nextReadyPollMs(t, wait);
  }
  return t;
};

describe('the delivery loop\'s recheck interval', () => {
  test('the first recheck is fast — a cell is ready in about a second', () => {
    expect(nextReadyPollMs(0, 0)).toBe(READY_POLL_MIN_MS);
    expect(nextReadyPollMs(0, Number.NaN)).toBe(READY_POLL_MIN_MS);
    expect(nextReadyPollMs(0, -1)).toBe(READY_POLL_MIN_MS);
  });

  test('it grows, so a slow provider is not polled hundreds of times', () => {
    expect(nextReadyPollMs(150, 150)).toBe(270);
    expect(nextReadyPollMs(420, 270)).toBe(486);
    expect(nextReadyPollMs(906, 486)).toBe(875);
  });

  test('NEVER SLOWER than the flat 3 s it replaced — the bug in the first attempt', () => {
    // A flat 3 s notices anything ready in (0, 3000] at exactly t=3000. A naive
    // geometric backoff does not: ticks at 1781 and 3356 make a runtime ready at
    // 2000 ms wait LONGER than before. Clamping every sleep to the next multiple
    // of the ceiling preserves the old grid and subdivides it, which is what
    // makes this true by construction.
    for (const readyAt of [1, 100, 200, 500, 999, 1_000, 1_500, 2_000, 2_500, 2_999,
                           3_000, 3_001, 4_000, 6_000, 8_000, 12_000, 30_000, 120_000]) {
      expect(noticedAt(readyAt, 'backoff')).toBeLessThanOrEqual(noticedAt(readyAt, 'flat'));
    }
  });

  test('and much faster for the case a cell is actually in', () => {
    expect(noticedAt(200, 'backoff')).toBe(420);
    expect(noticedAt(1_000, 'backoff')).toBe(1_781);
    expect(noticedAt(200, 'flat')).toBe(3_000);
    expect(noticedAt(1_000, 'flat')).toBe(3_000);
  });

  test('every sleep lands on or inside the 3 s grid, so the ceiling still holds', () => {
    let t = 0;
    let wait = READY_POLL_MIN_MS;
    for (let i = 0; i < 40; i++) {
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(READY_POLL_MAX_MS);
      t += wait;
      wait = nextReadyPollMs(t, wait);
    }
    // Past the ramp it is exactly the old interval, on the old boundaries.
    expect(t % READY_POLL_MAX_MS).toBe(0);
    expect(wait).toBe(READY_POLL_MAX_MS);
  });
});
