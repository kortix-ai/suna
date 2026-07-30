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
  BILLING_LIVENESS_GRACE_FLOOR_MINUTES,
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

  // BYTE-IDENTICAL. This is verbatim the arithmetic
  // providerAutoStopBackstopMinutes() performed while the two were one number.
  // The clamp is a pure function of graceMs, so proving graceMs is unchanged at
  // every input proves the merged money guarantee is unchanged too.
  test('REGRESSION: identical to the pre-split derivation at every idle window', () => {
    const preSplit = (idle: number) => Math.max(60, Math.max(1, idle || 15) * 2);
    for (const idle of [0, 1, 5, 15, 29, 30, 31, 45, 120, 720]) {
      cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = idle;
      expect(billingLivenessGraceMinutes()).toBe(preSplit(idle));
      expect(computeLivenessGraceMs()).toBe(preSplit(idle) * 60_000);
    }
  });

  test('never dips below its floor', () => {
    for (const idle of [undefined, 0, -5, 1, 29] as (number | undefined)[]) {
      cfg.KORTIX_SANDBOX_AUTOSTOP_MINUTES = idle;
      expect(billingLivenessGraceMinutes()).toBe(BILLING_LIVENESS_GRACE_FLOOR_MINUTES);
    }
  });

  // At LEAST two maintenance cycles, or a single missed pass silently zeroes a
  // healthy box's revenue.
  test('covers at least two maintenance passes', () => {
    const maintenanceIntervalMs = 5 * 60_000;
    expect(computeLivenessGraceMs()).toBeGreaterThanOrEqual(2 * maintenanceIntervalMs);
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
  test('REGRESSION: an 829-hour window bills only the grace past its last sighting', () => {
    const lastAliveAt = new Date(NOW.getTime() - 829 * HOUR);
    const end = billableWindowEnd({ requestedEnd: NOW, lastAliveAt, graceMs: GRACE });

    expect(end.getTime()).toBe(lastAliveAt.getTime() + GRACE);
    const billedHours = (end.getTime() - lastAliveAt.getTime()) / HOUR;
    expect(billedHours).toBe(1);
  });

  test('REGRESSION: no window can ever bill more than the grace past liveness', () => {
    for (const deadForHours of [2, 24, 100, 829, 10_000]) {
      const lastAliveAt = new Date(NOW.getTime() - deadForHours * HOUR);
      const end = billableWindowEnd({ requestedEnd: NOW, lastAliveAt, graceMs: GRACE });
      expect(end.getTime() - lastAliveAt.getTime()).toBeLessThanOrEqual(GRACE);
    }
  });

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
