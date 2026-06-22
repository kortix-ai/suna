import { describe, test, expect } from 'bun:test';
import { formatRelative, formatRelativeTime, formatRelativeDate } from './format-relative';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): number {
  return Date.now() - ms;
}

function ahead(ms: number): number {
  return Date.now() + ms;
}

describe('formatRelative invalid input', () => {
  test('returns null for null input by default', () => {
    expect(formatRelative(null)).toBeNull();
  });

  test('returns null for undefined input by default', () => {
    expect(formatRelative(undefined)).toBeNull();
  });

  test('returns the empty option for null input when provided', () => {
    expect(formatRelative(null, { empty: 'never' })).toBe('never');
  });

  test('returns the empty option for an unparseable date string', () => {
    expect(formatRelative('not a date', { empty: 'n/a' })).toBe('n/a');
  });

  test('returns null for a non-finite number', () => {
    expect(formatRelative(Infinity)).toBeNull();
  });
});

describe('formatRelative past times', () => {
  test('renders sub-minute past as just now', () => {
    expect(formatRelative(ago(30 * SECOND))).toBe('just now');
  });

  test('renders minutes ago', () => {
    expect(formatRelative(ago(5 * MINUTE))).toBe('5m ago');
  });

  test('renders hours ago', () => {
    expect(formatRelative(ago(3 * HOUR))).toBe('3h ago');
  });

  test('renders days ago', () => {
    expect(formatRelative(ago(2 * DAY))).toBe('2d ago');
  });

  test('floors fractional units by default', () => {
    expect(formatRelative(ago(5 * MINUTE + 59 * SECOND))).toBe('5m ago');
  });

  test('rounds units when round option is set', () => {
    expect(formatRelative(ago(5 * MINUTE + 40 * SECOND), { round: true })).toBe('6m ago');
  });

  test('accepts a Date instance', () => {
    expect(formatRelative(new Date(ago(10 * MINUTE)))).toBe('10m ago');
  });

  test('accepts an ISO date string', () => {
    const iso = new Date(ago(2 * HOUR)).toISOString();
    expect(formatRelative(iso)).toBe('2h ago');
  });
});

describe('formatRelative seconds option', () => {
  test('shows seconds when always enabled', () => {
    expect(formatRelative(ago(20 * SECOND), { seconds: true })).toBe('20s ago');
  });

  test('brief seconds shows just now under five seconds', () => {
    expect(formatRelative(ago(2 * SECOND), { seconds: 'brief' })).toBe('just now');
  });

  test('brief seconds shows the count between five and sixty seconds', () => {
    expect(formatRelative(ago(30 * SECOND), { seconds: 'brief' })).toBe('30s ago');
  });
});

describe('formatRelative future times', () => {
  test('renders future as just now when future is disabled', () => {
    expect(formatRelative(ahead(5 * MINUTE))).toBe('just now');
  });

  test('renders future minutes when future is enabled', () => {
    expect(formatRelative(ahead(5 * MINUTE), { future: true })).toBe('in 5m');
  });

  test('renders future hours when future is enabled', () => {
    expect(formatRelative(ahead(3 * HOUR), { future: true })).toBe('in 3h');
  });

  test('renders future days when future is enabled', () => {
    expect(formatRelative(ahead(2 * DAY), { future: true })).toBe('in 2d');
  });

  test('uses the default sub-minute future label', () => {
    expect(formatRelative(ahead(30 * SECOND), { future: true })).toBe('in <1m');
  });

  test('uses the in-a-moment future label when requested', () => {
    expect(
      formatRelative(ahead(30 * SECOND), { future: true, futureSoon: 'in-a-moment' }),
    ).toBe('in a moment');
  });
});

describe('formatRelative extended units', () => {
  test('full mode renders weeks', () => {
    expect(formatRelative(ago(14 * DAY), { extended: 'full' })).toBe('2w ago');
  });

  test('full mode renders months', () => {
    expect(formatRelative(ago(60 * DAY), { extended: 'full', maxRelativeDays: null })).toBe('2mo ago');
  });

  test('long mode renders months past seven days', () => {
    expect(formatRelative(ago(60 * DAY), { extended: 'long', maxRelativeDays: null })).toBe('2mo ago');
  });

  test('long mode renders years for very old timestamps', () => {
    expect(formatRelative(ago(400 * DAY), { extended: 'long', maxRelativeDays: null })).toBe('1y ago');
  });
});

describe('formatRelative date fallback', () => {
  test('falls back to an iso date past the max relative days', () => {
    const timestamp = ago(40 * DAY);
    const expected = new Date(timestamp).toISOString().slice(0, 10);
    expect(formatRelative(timestamp, { dateFallback: 'iso' })).toBe(expected);
  });

  test('falls back to days-ago string when dateFallback is false', () => {
    expect(formatRelative(ago(45 * DAY), { dateFallback: false })).toBe('45d ago');
  });

  test('never falls back when maxRelativeDays is null', () => {
    expect(formatRelative(ago(100 * DAY), { maxRelativeDays: null })).toBe('100d ago');
  });
});

describe('formatRelative aliases', () => {
  test('formatRelativeTime is the same function', () => {
    expect(formatRelativeTime).toBe(formatRelative);
  });

  test('formatRelativeDate is the same function', () => {
    expect(formatRelativeDate).toBe(formatRelative);
  });
});
