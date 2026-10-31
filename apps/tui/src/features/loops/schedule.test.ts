import { describe, expect, test } from 'bun:test';

import { durationSeconds, parseSchedule } from './schedule.ts';

describe('durationSeconds', () => {
  test('reads a number and a unit', () => {
    expect([durationSeconds('30m'), durationSeconds('2h'), durationSeconds('1D')]).toEqual([
      1800, 7200, 86_400,
    ]);
  });

  test('refuses anything else', () => {
    expect([durationSeconds('30'), durationSeconds('m'), durationSeconds('1.5h')]).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('parseSchedule', () => {
  test('every <duration> is a recurring loop', () => {
    expect(parseSchedule('every 30m')).toEqual({ ok: true, schedule: { every: '30m' } });
    expect(parseSchedule('  Every   1H ')).toEqual({ ok: true, schedule: { every: '1h' } });
  });

  test('every under 5 minutes is refused with the API rule', () => {
    expect(parseSchedule('every 2m')).toEqual({
      ok: false,
      reason: 'A loop runs at most once every 5m.',
    });
  });

  test('in <duration> is one later run', () => {
    expect(parseSchedule('in 2h')).toEqual({ ok: true, schedule: { in: '2h' } });
    expect(parseSchedule('in 30s').ok).toBe(true);
  });

  test('at <ISO> is one run at an instant; a bad date is refused', () => {
    expect(parseSchedule('at 2026-11-02T09:00:00Z')).toEqual({
      ok: true,
      schedule: { at: '2026-11-02T09:00:00Z' },
    });
    expect(parseSchedule('at tomorrow').ok).toBe(false);
  });

  test('cron needs 5 fields', () => {
    expect(parseSchedule('cron 0 9 * * 1-5')).toEqual({
      ok: true,
      schedule: { cron: '0 9 * * 1-5' },
    });
    expect(parseSchedule('cron 0 9 * *').ok).toBe(false);
  });

  test('empty and unknown input name the accepted forms', () => {
    const empty = parseSchedule('');
    const unknown = parseSchedule('daily');
    expect(empty.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toContain('every');
  });
});
