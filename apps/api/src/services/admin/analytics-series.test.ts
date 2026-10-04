import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ANALYTICS_DAYS,
  MAX_ANALYTICS_DAYS,
  buildActivityDays,
  buildUsageDays,
  dayKeys,
  parseDays,
  startOfUtcDay,
  trailingSum,
  utcDayKey,
  windowStart,
} from './analytics-series';

// A fixed instant late in the UTC day, so any accidental local-timezone
// arithmetic shifts the bucket and fails loudly instead of passing in CI's UTC
// container and breaking on a developer's machine.
const NOW = new Date('2026-08-07T22:30:00.000Z');

describe('parseDays', () => {
  test('defaults to 30 when absent, empty, or non-numeric', () => {
    expect(parseDays(undefined)).toBe(DEFAULT_ANALYTICS_DAYS);
    expect(parseDays(null)).toBe(DEFAULT_ANALYTICS_DAYS);
    expect(parseDays('')).toBe(DEFAULT_ANALYTICS_DAYS);
    expect(parseDays('   ')).toBe(DEFAULT_ANALYTICS_DAYS);
    expect(parseDays('abc')).toBe(DEFAULT_ANALYTICS_DAYS);
    expect(parseDays('NaN')).toBe(DEFAULT_ANALYTICS_DAYS);
  });

  test('passes through an in-range integer', () => {
    expect(parseDays('7')).toBe(7);
    expect(parseDays('1')).toBe(1);
    expect(parseDays('90')).toBe(90);
  });

  test('clamps to [1, 90]', () => {
    expect(parseDays('0')).toBe(1);
    expect(parseDays('-5')).toBe(1);
    expect(parseDays('91')).toBe(MAX_ANALYTICS_DAYS);
    expect(parseDays('100000')).toBe(MAX_ANALYTICS_DAYS);
  });

  test('rejects Infinity rather than clamping it to the max', () => {
    // Number('Infinity') is finite-looking to a naive `> 0` check but would
    // make `Array.from({length: days})` throw. Fall back to the default.
    expect(parseDays('Infinity')).toBe(DEFAULT_ANALYTICS_DAYS);
    expect(parseDays('-Infinity')).toBe(DEFAULT_ANALYTICS_DAYS);
  });

  test('truncates a fractional value instead of producing a partial bucket', () => {
    expect(parseDays('7.9')).toBe(7);
    expect(parseDays('0.5')).toBe(1);
  });
});

describe('utcDayKey / startOfUtcDay / windowStart', () => {
  test('utcDayKey uses the UTC calendar day, not local time', () => {
    expect(utcDayKey(NOW)).toBe('2026-08-07');
    expect(utcDayKey(new Date('2026-08-07T00:00:00.000Z'))).toBe('2026-08-07');
    expect(utcDayKey(new Date('2026-08-07T23:59:59.999Z'))).toBe('2026-08-07');
  });

  test('startOfUtcDay snaps to midnight UTC', () => {
    expect(startOfUtcDay(NOW).toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });

  test('windowStart(1) is today; windowStart(30) is 29 days back', () => {
    expect(windowStart(1, NOW).toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(windowStart(30, NOW).toISOString()).toBe('2026-07-09T00:00:00.000Z');
  });

  test('windowStart crosses a month boundary correctly', () => {
    expect(windowStart(10, new Date('2026-03-05T12:00:00.000Z')).toISOString()).toBe(
      '2026-02-24T00:00:00.000Z',
    );
  });
});

describe('dayKeys', () => {
  test('returns exactly `days` ascending keys ending today', () => {
    const keys = dayKeys(5, NOW);
    expect(keys).toEqual(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);
  });

  test('returns 90 unique keys at the maximum window', () => {
    const keys = dayKeys(MAX_ANALYTICS_DAYS, NOW);
    expect(keys.length).toBe(90);
    expect(new Set(keys).size).toBe(90);
    expect(keys[89]).toBe('2026-08-07');
  });

  test('spans a leap day without duplicating or skipping', () => {
    const keys = dayKeys(4, new Date('2028-03-01T06:00:00.000Z'));
    expect(keys).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
  });
});

describe('buildActivityDays', () => {
  const keys = dayKeys(3, NOW); // 2026-08-05 .. 2026-08-07

  test('zero-fills days that have no rows', () => {
    const result = buildActivityDays(
      keys,
      [
        {
          date: '2026-08-07',
          sessionsCreated: 12,
          activeAccounts: 4,
          activeUsers: 5,
          activeProjects: 3,
        },
      ],
      [{ date: '2026-08-06', newAccounts: 2 }],
    );

    expect(result).toEqual([
      {
        date: '2026-08-05',
        sessionsCreated: 0,
        activeAccounts: 0,
        activeUsers: 0,
        newAccounts: 0,
        activeProjects: 0,
      },
      {
        date: '2026-08-06',
        sessionsCreated: 0,
        activeAccounts: 0,
        activeUsers: 0,
        newAccounts: 2,
        activeProjects: 0,
      },
      {
        date: '2026-08-07',
        sessionsCreated: 12,
        activeAccounts: 4,
        activeUsers: 5,
        newAccounts: 0,
        activeProjects: 3,
      },
    ]);
  });

  test('drops rows outside the window instead of appending them', () => {
    const result = buildActivityDays(
      keys,
      [
        {
          date: '2026-01-01',
          sessionsCreated: 999,
          activeAccounts: 9,
          activeUsers: 9,
          activeProjects: 9,
        },
      ],
      [{ date: '2026-01-01', newAccounts: 999 }],
    );
    expect(result.length).toBe(3);
    expect(result.map((d) => d.date)).toEqual(keys);
    expect(result.every((d) => d.sessionsCreated === 0 && d.newAccounts === 0)).toBe(true);
  });

  test('returns an empty series for an empty key list', () => {
    expect(buildActivityDays([], [], [])).toEqual([]);
  });
});

describe('buildUsageDays', () => {
  const keys = dayKeys(3, NOW);

  test('folds categories into one entry per day and zero-fills gaps', () => {
    const result = buildUsageDays(
      keys,
      [
        { date: '2026-08-06', category: 'compute', usd: 1.5 },
        { date: '2026-08-06', category: 'llm', usd: 2.25 },
        { date: '2026-08-07', category: 'other', usd: 0.5 },
      ],
      [
        { date: '2026-08-06', payingAccounts: 3 },
        { date: '2026-08-07', payingAccounts: 1 },
      ],
    );

    expect(result).toEqual([
      {
        date: '2026-08-05',
        computeUsd: 0,
        llmUsd: 0,
        otherUsd: 0,
        totalUsd: 0,
        payingAccounts: 0,
      },
      {
        date: '2026-08-06',
        computeUsd: 1.5,
        llmUsd: 2.25,
        otherUsd: 0,
        totalUsd: 3.75,
        payingAccounts: 3,
      },
      {
        date: '2026-08-07',
        computeUsd: 0,
        llmUsd: 0,
        otherUsd: 0.5,
        totalUsd: 0.5,
        payingAccounts: 1,
      },
    ]);
  });

  test('sums repeated (day, category) rows — llm_debit and token_overage both map to llm', () => {
    const result = buildUsageDays(
      ['2026-08-07'],
      [
        { date: '2026-08-07', category: 'llm', usd: 1 },
        { date: '2026-08-07', category: 'llm', usd: 2 },
      ],
      [],
    );
    expect(result[0]!.llmUsd).toBe(3);
    expect(result[0]!.totalUsd).toBe(3);
  });

  test('totalUsd always equals the sum of its three parts', () => {
    const result = buildUsageDays(
      keys,
      [
        { date: '2026-08-05', category: 'compute', usd: 0.1 },
        { date: '2026-08-05', category: 'llm', usd: 0.2 },
        { date: '2026-08-05', category: 'other', usd: 0.3 },
      ],
      [],
    );
    for (const day of result) {
      expect(day.totalUsd).toBeCloseTo(day.computeUsd + day.llmUsd + day.otherUsd, 10);
    }
  });
});

describe('trailingSum', () => {
  const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ n }));
  const pick = (d: { n: number }) => d.n;

  test('sums the last `window` entries', () => {
    expect(trailingSum(series, pick, 3)).toBe(27); // 8 + 9 + 10
  });

  test('offset shifts the window back — the previous period', () => {
    expect(trailingSum(series, pick, 3, 3)).toBe(18); // 5 + 6 + 7
  });

  test('clamps a window longer than the series', () => {
    expect(trailingSum(series, pick, 100)).toBe(55);
  });

  test('returns 0 when the offset consumes the whole series', () => {
    expect(trailingSum(series, pick, 3, 10)).toBe(0);
    expect(trailingSum(series, pick, 3, 99)).toBe(0);
    expect(trailingSum([], pick, 7)).toBe(0);
  });
});
