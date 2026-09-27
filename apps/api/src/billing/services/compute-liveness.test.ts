import { afterEach, describe, expect, mock, test } from 'bun:test';

// Only the grace constant reaches for config (the real one process.exits on an
// incomplete local env). Everything else here is pure and takes its grace as an
// argument. Mutable so a test can sweep the idle window.
const cfg: {
  KORTIX_SANDBOX_AUTOSTOP_MINUTES?: number;
  KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES?: number;
} = { KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15 };
mock.module('../../config', () => ({ config: cfg }));

const {
  billableWindowEnd,
  billingLivenessGraceMinutes,
  computeLivenessGraceMs,
  isBeyondLivenessCeiling,
  lastAliveAtOf,
  parseTimestamp,
} = await import('./compute-liveness');

const HOUR = 3_600_000;
const GRACE = HOUR; // billingLivenessGraceMinutes() is 60 in prod
const NOW = new Date('2026-07-29T12:00:00Z');

/** kortix-prod-env, confirmed 2026-07-29. */
const PROD_IDLE_WINDOW_MINUTES = 15;

afterEach(() => {
  cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = PROD_IDLE_WINDOW_MINUTES;
  cfg.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES = undefined;
});

describe('billingLivenessGraceMinutes — the money knob, and only the money knob', () => {
  test('is 60 minutes on the prod idle window', () => {
    expect(billingLivenessGraceMinutes()).toBe(60);
    expect(computeLivenessGraceMs()).toBe(GRACE);
  });

  // The grace in minutes per idle window: at least 60, else twice the idle
  // window (the reaper may legitimately leave a box idle that long). Missing,
  // zero, and negative idle windows fall back to the floor.
  test.each([
    [undefined, 60],
    [-5, 60],
    [0, 60],
    [1, 60],
    [5, 60],
    [15, 60],
    [29, 60],
    [30, 60],
    [31, 62],
    [45, 90],
    [120, 240],
    [720, 1440],
  ] as const)('an idle window of %p minutes gives a grace of %p minutes', (idle, minutes) => {
    cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = idle;
    expect(billingLivenessGraceMinutes()).toBe(minutes);
    expect(computeLivenessGraceMs()).toBe(minutes * 60_000);
  });

  // THE DECOUPLING, direction 2. The provider's idle timer is 12x this number
  // and must be free to grow further; before the split it WAS this number, so
  // raising it raised the bill ceiling with it. The ordering relation between
  // the two lives in platform/providers/autostop-backstop.test.ts.
  test('REGRESSION: does not move when the provider backstop moves', () => {
    for (const backstop of [60, 720, 1440, 100_000]) {
      cfg.KORTIX_SANDBOX_PROVIDER_AUTOSTOP_MINUTES = backstop;
      expect(billingLivenessGraceMinutes()).toBe(60);
    }
  });
});

describe('parseTimestamp', () => {
  test('accepts Date and ISO string', () => {
    expect(parseTimestamp(NOW)?.getTime()).toBe(NOW.getTime());
    expect(parseTimestamp(NOW.toISOString())?.getTime()).toBe(NOW.getTime());
  });
  test('rejects null, garbage and an invalid Date', () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('not-a-date')).toBeNull();
    expect(parseTimestamp(new Date('nope'))).toBeNull();
    expect(parseTimestamp(12345)).toBeNull();
  });
});

describe('lastAliveAtOf', () => {
  const startedAt = new Date(NOW.getTime() - 10 * HOUR);

  test('uses the stamped control-plane observation', () => {
    const seen = new Date(NOW.getTime() - HOUR);
    expect(
      lastAliveAtOf({ metadata: { lastAliveAt: seen.toISOString() }, startedAt }).getTime(),
    ).toBe(seen.getTime());
  });

  // A row that has NEVER been re-observed bills its opening grace and no more.
  test('falls back to the window start when never re-observed', () => {
    expect(lastAliveAtOf({ metadata: {}, startedAt }).getTime()).toBe(startedAt.getTime());
    expect(lastAliveAtOf({ startedAt }).getTime()).toBe(startedAt.getTime());
  });

  test('ignores a stamp older than the window start', () => {
    expect(
      lastAliveAtOf({
        metadata: { lastAliveAt: new Date(startedAt.getTime() - HOUR).toISOString() },
        startedAt,
      }).getTime(),
    ).toBe(startedAt.getTime());
  });

  test('ignores a garbage stamp rather than throwing', () => {
    expect(lastAliveAtOf({ metadata: { lastAliveAt: 'nope' }, startedAt }).getTime()).toBe(
      startedAt.getTime(),
    );
  });
});

describe('billableWindowEnd — the clamp that caps the whole defect class', () => {
  test('a freshly observed box bills right up to now', () => {
    const lastAliveAt = new Date(NOW.getTime() - 60_000);
    expect(billableWindowEnd({ requestedEnd: NOW, lastAliveAt, graceMs: GRACE }).getTime()).toBe(
      NOW.getTime(),
    );
  });

  test('bills exactly to the ceiling at the boundary', () => {
    const lastAliveAt = new Date(NOW.getTime() - GRACE);
    expect(billableWindowEnd({ requestedEnd: NOW, lastAliveAt, graceMs: GRACE }).getTime()).toBe(
      NOW.getTime(),
    );
  });

  // THE 829-hour row: dead since 2026-06-24, still billing on 2026-07-29.
  // Pre-clamp this settles 829 hours. It must now settle exactly the grace.
  test.each([2, 24, 100, 829, 10_000])(
    'REGRESSION: a box dead for %p hours bills exactly the grace past its last sighting',
    (deadForHours) => {
      const lastAliveAt = new Date(NOW.getTime() - deadForHours * HOUR);
      const end = billableWindowEnd({ requestedEnd: NOW, lastAliveAt, graceMs: GRACE });
      expect(end.getTime()).toBe(lastAliveAt.getTime() + GRACE);
    },
  );

  test('never extends a window that ends before the ceiling', () => {
    const requestedEnd = new Date(NOW.getTime() - 5 * HOUR);
    expect(billableWindowEnd({ requestedEnd, lastAliveAt: NOW, graceMs: GRACE }).getTime()).toBe(
      requestedEnd.getTime(),
    );
  });
});

describe('isBeyondLivenessCeiling', () => {
  test('a row that can never bill again is beyond the ceiling', () => {
    expect(
      isBeyondLivenessCeiling({
        now: NOW,
        lastAliveAt: new Date(NOW.getTime() - GRACE - 1),
        graceMs: GRACE,
      }),
    ).toBe(true);
  });
  test('a row exactly at the ceiling can still bill', () => {
    expect(
      isBeyondLivenessCeiling({
        now: NOW,
        lastAliveAt: new Date(NOW.getTime() - GRACE),
        graceMs: GRACE,
      }),
    ).toBe(false);
  });
});
