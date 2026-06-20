import { describe, expect, test } from 'bun:test';

import { formatInTimeZone } from './local-time';

/**
 * Regression test for React hydration error #418 (Better Stack incident
 * 8bc2dce807e38e8d6e7548d6be722bdbb58ecb32af7848cd2a5013144b0384f8).
 *
 * Root cause: server components rendered dates with `toLocaleString` /
 * `toLocaleDateString`, which format in the runtime's *default* timezone. The
 * server (UTC) and the browser (the viewer's timezone) then emit different text
 * for the same instant, so React's hydration text comparison fails.
 *
 * The fix renders a timezone-stable UTC string on the server (via
 * `formatInTimeZone(..., 'UTC')`) and only localizes after mount. These tests
 * pin that invariant: the server-rendered text must be identical no matter what
 * the host's default timezone is.
 */

// An instant late in the UTC day — the worst case, where the calendar day and
// the time-of-day both differ across timezones.
const NEAR_MIDNIGHT_UTC = new Date('2026-06-07T23:30:00.000Z');

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

const DATETIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

describe('formatInTimeZone — hydration-safe server rendering', () => {
  test('UTC date format is stable for a near-midnight-UTC instant', () => {
    // This is what the server (and the first client render) produces. It must
    // be a fixed, well-known string — never timezone-dependent.
    expect(formatInTimeZone(NEAR_MIDNIGHT_UTC, DATE_FORMAT, 'UTC')).toBe(
      'June 7, 2026',
    );
  });

  test('UTC datetime format is stable for a near-midnight-UTC instant', () => {
    expect(formatInTimeZone(NEAR_MIDNIGHT_UTC, DATETIME_FORMAT, 'UTC')).toBe(
      'Sun, Jun 7, 11:30 PM',
    );
  });

  test('output does not depend on the runtime default timezone', () => {
    // Same instant + same explicit zone ⇒ identical text, regardless of how the
    // host machine is configured. (The pre-fix code, which relied on the
    // default zone, would diverge here between server and client.)
    const baseline = formatInTimeZone(NEAR_MIDNIGHT_UTC, DATETIME_FORMAT, 'UTC');
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
        process.env.TZ = tz;
        expect(formatInTimeZone(NEAR_MIDNIGHT_UTC, DATETIME_FORMAT, 'UTC')).toBe(
          baseline,
        );
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test('demonstrates the bug it guards against: default-zone formatting diverges', () => {
    // Sanity-check that the timezones we picked actually produce different
    // wall-clock text — i.e. the old `toLocale*` approach really was unsafe.
    const utc = formatInTimeZone(NEAR_MIDNIGHT_UTC, DATETIME_FORMAT, 'UTC');
    const tokyo = formatInTimeZone(NEAR_MIDNIGHT_UTC, DATETIME_FORMAT, 'Asia/Tokyo');
    expect(tokyo).not.toBe(utc); // Jun 7 11:30 PM (UTC) vs Jun 8 8:30 AM (JST)
  });
});
