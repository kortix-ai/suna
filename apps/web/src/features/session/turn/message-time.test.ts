import { describe, expect, test } from 'bun:test';

import type { MessageWithParts } from '@/ui';

import {
  formatMessageTime,
  formatMessageTimeFull,
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

/** Wednesday 12 August 2026, 15:00 UTC. Every case below is relative to it. */
const NOW = Date.UTC(2026, 7, 12, 15, 0, 0);

const utc = { timeZone: 'UTC', locale: 'en-US' };

const fmt = (ts: number | null | undefined, now: number | null = NOW, opts = utc) =>
  norm(formatMessageTime(ts, now, opts));

describe('formatMessageTime — how far back it was decides how much is shown', () => {
  test('a message from today is just a clock reading', () => {
    expect(fmt(Date.UTC(2026, 7, 12, 9, 34))).toBe('9:34 AM');
  });

  test('midnight today is still today, not yesterday', () => {
    expect(fmt(Date.UTC(2026, 7, 12, 0, 5))).toBe('12:05 AM');
  });

  test('yesterday is named, because "9:05 PM" alone would read as today', () => {
    expect(fmt(Date.UTC(2026, 7, 11, 21, 5))).toBe('Yesterday 9:05 PM');
  });

  test('inside the last week the weekday places it fastest', () => {
    // 9 Aug 2026 is a Sunday; 6 Aug is a Thursday.
    expect(fmt(Date.UTC(2026, 7, 9, 14, 0))).toBe('Sun 2:00 PM');
    expect(fmt(Date.UTC(2026, 7, 6, 8, 0))).toBe('Thu 8:00 AM');
  });

  test('at seven days the weekday stops being unambiguous and the date takes over', () => {
    expect(fmt(Date.UTC(2026, 7, 5, 8, 0))).toBe('Aug 5, 8:00 AM');
  });

  test('a different year says so', () => {
    expect(fmt(Date.UTC(2025, 7, 12, 10, 15))).toBe('Aug 12, 2025, 10:15 AM');
  });

  test('this year does not repeat the year', () => {
    expect(fmt(Date.UTC(2026, 0, 3, 10, 15))).toBe('Jan 3, 10:15 AM');
  });
});

describe('formatMessageTime — the parts that are easy to get wrong', () => {
  test('"today" is decided in the render zone, not the runtime zone', () => {
    // 02:30 UTC on the 12th is 22:30 on the 11th in New York. Asking the
    // question in UTC would print "2:30 AM" next to a clock face reading
    // 10:30 PM — the day and the time would disagree on screen.
    const ts = Date.UTC(2026, 7, 12, 2, 30);
    expect(fmt(ts)).toBe('2:30 AM');
    expect(fmt(ts, NOW, { timeZone: 'America/New_York', locale: 'en-US' })).toBe(
      'Yesterday 10:30 PM',
    );
  });

  test('a stamp slightly ahead of the clock reads as today, never as the future', () => {
    // Sandbox/browser skew can push a stamp past midnight. "Tomorrow 1:00 AM"
    // would be a bug on screen; the clamp makes the skew invisible instead.
    expect(fmt(Date.UTC(2026, 7, 13, 1, 0))).toBe('1:00 AM');
  });

  test('field order and 12/24-hour follow the locale, not this module', () => {
    expect(fmt(Date.UTC(2026, 7, 5, 8, 0))).toBe('Aug 5, 8:00 AM');
    const gb = fmt(Date.UTC(2026, 7, 5, 8, 0), NOW, { timeZone: 'UTC', locale: 'en-GB' });
    expect(gb).toContain('5 Aug');
    expect(gb).not.toContain('AM');
  });

  test('a null clock returns the unambiguous full form — the server-render case', () => {
    // The server cannot know the viewer's day, so it must not guess one.
    expect(fmt(Date.UTC(2026, 7, 12, 9, 34), null)).toBe('Aug 12, 2026, 9:34 AM');
  });
});

describe('formatMessageTime — absent data renders nothing, not a placeholder', () => {
  const absent: Array<[string, number | null | undefined]> = [
    ['undefined', undefined],
    ['null', null],
    ['zero (a missing stamp, not 1970)', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ];

  for (const [label, value] of absent) {
    test(`${label} renders as an empty string`, () => {
      expect(formatMessageTime(value, NOW, utc)).toBe('');
    });
  }
});

describe('formatMessageTimeFull', () => {
  test('spells the instant out for the hover title', () => {
    expect(norm(formatMessageTimeFull(Date.UTC(2026, 7, 12, 9, 34), utc))).toBe(
      'Wednesday, August 12, 2026 at 9:34 AM',
    );
  });

  test('is empty for a missing stamp', () => {
    expect(formatMessageTimeFull(undefined, utc)).toBe('');
  });
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

  for (const [label, value] of rejected) {
    test(`rejects ${label}`, () => {
      expect(messageCreatedAt(withTime(value))).toBeNull();
    });
  }

  test('messageTime returns an empty object rather than throwing on a bare info', () => {
    expect(messageTime({ info: { id: 'm1', role: 'user' } } as MessageWithParts)).toEqual({});
    expect(messageTime(undefined)).toEqual({});
  });
});
