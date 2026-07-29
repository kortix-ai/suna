import { describe, expect, mock, test } from 'bun:test';

// Only `computeLivenessGraceMs` reaches for the provider module (and through it
// the real config, which process.exits on an incomplete local env). The rules
// under test are pure and take their grace as an argument.
mock.module('../../platform/providers', () => ({
  providerAutoStopBackstopMinutes: () => 60,
}));

const { billableWindowEnd, computeLivenessGraceMs, isBeyondLivenessCeiling, lastAliveAtOf, parseTimestamp } =
  await import('./compute-liveness');

const HOUR = 3_600_000;
const GRACE = HOUR; // providerAutoStopBackstopMinutes() is 60 in prod
const NOW = new Date('2026-07-29T12:00:00Z');

describe('computeLivenessGraceMs', () => {
  // Pinned to the provider's own idle auto-stop, because that is the hard
  // physical bound on how long the box can still exist.
  test('is the provider auto-stop backstop, in ms', () => {
    expect(computeLivenessGraceMs()).toBe(GRACE);
  });

  // The grace has to sit inside a window nothing else enforced before:
  //  - at LEAST two maintenance cycles, or a single missed pass silently zeroes
  //    a healthy box's revenue;
  //  - at MOST the provider auto-stop, or we bill past the point the box can
  //    physically exist, which is the bug this whole change exists to kill.
  test('sits between two reaper passes and the provider auto-stop', () => {
    const maintenanceIntervalMs = 5 * 60_000;
    expect(computeLivenessGraceMs()).toBeGreaterThanOrEqual(2 * maintenanceIntervalMs);
    expect(computeLivenessGraceMs()).toBeLessThanOrEqual(60 * 60_000);
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
    expect(
      billableWindowEnd({ requestedEnd: NOW, lastAliveAt, graceMs: GRACE }).getTime(),
    ).toBe(NOW.getTime());
  });

  test('bills exactly to the ceiling at the boundary', () => {
    const lastAliveAt = new Date(NOW.getTime() - GRACE);
    expect(
      billableWindowEnd({ requestedEnd: NOW, lastAliveAt, graceMs: GRACE }).getTime(),
    ).toBe(NOW.getTime());
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
    expect(
      billableWindowEnd({ requestedEnd, lastAliveAt: NOW, graceMs: GRACE }).getTime(),
    ).toBe(requestedEnd.getTime());
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
