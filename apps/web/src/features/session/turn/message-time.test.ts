import { describe, expect, test } from 'bun:test';

import type { MessageWithParts } from '@/ui';

import {
  formatMessageDay,
  formatMessageExact,
  messageCreatedAt,
  messageTime,
} from './message-time';

/**
 * ICU >= 72 separates the time from the day period with U+202F (narrow no-break
 * space), not U+0020 — so `'9:34 AM'` compares unequal to its own output on a
 * modern runtime. Normalizing here keeps the expectations readable and keeps
 * the suite from breaking on an ICU bump that changed nothing a user can see.
 */
const norm = (value: string) => value.replace(/[\u202f\u00a0]/g, ' ');

/** Wednesday 12 August 2026, 15:00:00 UTC. Every case below is relative to it. */
const NOW = Date.UTC(2026, 7, 12, 15, 0, 0);

const utc = { timeZone: 'UTC', locale: 'en-US' };

const label = (ts: number | null | undefined, now: number | null = NOW, opts = utc) =>
  formatMessageDay(ts, now, opts);
const exact = (ts: number | null | undefined, opts = utc) => norm(formatMessageExact(ts, opts));

describe('formatMessageDay — recent reads as distance', () => {
  test('under a minute is one word, not a second-by-second countdown', () => {
    expect(label(Date.UTC(2026, 7, 12, 14, 59, 30))).toBe('just now');
    expect(label(Date.UTC(2026, 7, 12, 15, 0, 0))).toBe('just now');
  });

  test('minutes, hours, days', () => {
    expect(label(Date.UTC(2026, 7, 12, 14, 59, 0))).toBe('1 minute ago');
    expect(label(Date.UTC(2026, 7, 12, 14, 55, 0))).toBe('5 minutes ago');
    expect(label(Date.UTC(2026, 7, 12, 12, 0, 0))).toBe('3 hours ago');
    expect(label(Date.UTC(2026, 7, 7, 15, 0, 0))).toBe('5 days ago');
  });

  test('a stamp ahead of the clock reads as just now, never as the future', () => {
    // Sandbox/browser skew can push a stamp past the browser's clock.
    // "in 30 seconds" would be a bug on screen; the clamp hides the skew.
    expect(label(Date.UTC(2026, 7, 12, 15, 0, 30))).toBe('just now');
    expect(label(Date.UTC(2026, 7, 13, 1, 0, 0))).toBe('just now');
  });
});

describe('formatMessageDay — past a week, distance stops helping', () => {
  test('at exactly a week the date takes over', () => {
    // Nobody counts to "23 days ago". The handover is the point of the ladder.
    expect(label(Date.UTC(2026, 7, 5, 16, 0, 0))).toContain('ago');
    expect(label(Date.UTC(2026, 7, 5, 15, 0, 0))).toBe('August 5');
  });

  test('this year omits the year; any other year states it', () => {
    expect(label(Date.UTC(2026, 5, 9, 10, 15))).toBe('June 9');
    expect(label(Date.UTC(2025, 5, 9, 10, 15))).toBe('June 9, 2025');
  });

  test('field order follows the locale, not this module', () => {
    expect(label(Date.UTC(2026, 5, 9, 10, 15), NOW, { timeZone: 'UTC', locale: 'en-GB' })).toBe(
      '9 June',
    );
  });

  test('"same year" is asked in the render zone', () => {
    // 1 Jan 2026 00:30 UTC is still 2025 in New York, so the year must show.
    const ts = Date.UTC(2026, 0, 1, 0, 30);
    expect(label(ts)).toBe('January 1');
    expect(label(ts, NOW, { timeZone: 'America/New_York', locale: 'en-US' })).toBe(
      'December 31, 2025',
    );
  });

  test('a null clock returns the dated form — the server-render case', () => {
    // The server cannot know the viewer's clock, so it must not guess a
    // distance. A relative word here is the hydration bug this avoids.
    expect(label(Date.UTC(2026, 7, 12, 9, 34), null)).toBe('August 12, 2026');
    expect(label(Date.UTC(2026, 7, 12, 9, 34), null)).not.toContain('ago');
  });
});

describe('formatMessageExact — the hover label is the whole instant', () => {
  test('spells out the full date and the time of day', () => {
    expect(exact(Date.UTC(2026, 5, 9, 14, 32, 5))).toBe('June 9, 2026 2:32 PM');
    expect(exact(Date.UTC(2026, 7, 12, 9, 34, 0))).toBe('August 12, 2026 9:34 AM');
  });

  test('stops at minutes — a seconds reading looks worth reading and never is', () => {
    expect(exact(Date.UTC(2026, 5, 9, 14, 32, 5))).not.toMatch(/:\d{2}:\d{2}/);
  });

  test('12- vs 24-hour and field order follow the locale', () => {
    const gb = exact(Date.UTC(2026, 5, 9, 14, 32, 5), { timeZone: 'UTC', locale: 'en-GB' });
    expect(gb).toContain('9 June 2026');
    expect(gb).toContain('14:32');
    expect(gb).not.toContain('PM');
  });

  test('renders in the given zone', () => {
    expect(
      exact(Date.UTC(2026, 5, 9, 2, 30, 0), { timeZone: 'America/New_York', locale: 'en-US' }),
    ).toBe('June 8, 2026 10:30 PM');
  });

  test('the day period is upper case in every locale that has one', () => {
    // CLDR does not agree with itself: `en-US` gives "PM", while `en-AU`,
    // `en-NZ` and `en-IN` give a lowercase "pm". Left alone, the same code
    // renders differently for two readers for no reason they can see.
    const afternoon = Date.UTC(2026, 5, 9, 14, 32, 0);
    const morning = Date.UTC(2026, 5, 9, 9, 5, 0);

    for (const locale of ['en-US', 'en-AU', 'en-NZ', 'en-IN', 'en-CA', 'en-PH']) {
      const pm = exact(afternoon, { timeZone: 'UTC', locale });
      const am = exact(morning, { timeZone: 'UTC', locale });
      expect(pm).not.toContain('pm');
      expect(am).not.toContain('am');
      // …and it is actually present, so the assertions above are not passing
      // simply because the locale renders a 24-hour clock.
      expect(pm.toUpperCase()).toContain('PM');
      expect(am.toUpperCase()).toContain('AM');
    }
  });

  test('uppercasing the day period leaves the rest of the string alone', () => {
    // Month names must not be shouted at the reader as a side effect.
    expect(exact(Date.UTC(2026, 5, 9, 14, 32, 0), { timeZone: 'UTC', locale: 'en-US' })).toBe(
      'June 9, 2026 2:32 PM',
    );
  });
});

describe('absent data renders nothing, not a placeholder', () => {
  const absent: Array<[string, number | null | undefined]> = [
    ['undefined', undefined],
    ['null', null],
    ['zero (a missing stamp, not 1970)', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  for (const [name, value] of absent) {
    test(`${name} renders as an empty string in both formatters`, () => {
      expect(formatMessageDay(value, NOW, utc)).toBe('');
      expect(formatMessageExact(value, utc)).toBe('');
    });
  }
});

describe('messageCreatedAt', () => {
  const withTime = (created: unknown) =>
    ({ info: { id: 'm1', role: 'user', time: { created } }, parts: [] }) as unknown as MessageWithParts;

  test('reads the stamp off the union arm', () => {
    expect(messageCreatedAt(withTime(1_760_000_000_000))).toBe(1_760_000_000_000);
  });

  test('tolerates a message with no time at all', () => {
    // The existing `user-message.test.tsx` fixture is exactly this shape.
    expect(messageCreatedAt({ info: { id: 'm1', role: 'user' } } as MessageWithParts)).toBeNull();
    expect(messageCreatedAt(undefined)).toBeNull();
  });

  const rejected: Array<[string, unknown]> = [
    ['zero', 0],
    ['a negative stamp', -1],
    ['NaN', Number.NaN],
    ['a numeric string', '1760000000000'],
  ];

  for (const [name, value] of rejected) {
    test(`rejects ${name}`, () => {
      expect(messageCreatedAt(withTime(value))).toBeNull();
    });
  }

  test('messageTime returns an empty object rather than throwing on a bare info', () => {
    expect(messageTime({ info: { id: 'm1', role: 'user' } } as MessageWithParts)).toEqual({});
    expect(messageTime(undefined)).toEqual({});
  });
});
