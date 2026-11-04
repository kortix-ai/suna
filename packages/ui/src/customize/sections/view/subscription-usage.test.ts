import { describe, expect, test } from 'bun:test';
import { formatReset, shownUsage, usageTone, weeklyModel } from './subscription-usage';

const window = (used_percent: number) => ({ id: 'five_hour', window_minutes: 300, used_percent, resets_at: null });
const snapshot = (observed_at: string, percent: number) => ({
  windows: [window(percent)], limited: false, observed_at, source: 'response' as const,
});

describe('subscription usage meters', () => {
  test('tone: plain under 90 %, near from 90 %, limited at 100 % or when the provider refuses near the top', () => {
    expect(usageTone(window(89.9), false)).toBe('ok');
    expect(usageTone(window(90), false)).toBe('near');
    expect(usageTone(window(100), false)).toBe('limited');
    expect(usageTone(window(95), true)).toBe('limited');
    // A refusal names the window that is full; a weekly bar at 20 % stays plain.
    expect(usageTone(window(20), true)).toBe('ok');
  });

  test('a model-specific weekly window names its model', () => {
    expect(weeklyModel('seven_day_opus')).toBe('Opus');
    expect(weeklyModel('7d_sonnet')).toBe('Sonnet');
    expect(weeklyModel('weekly')).toBeNull();
  });

  test('the newer of the live read and the listed snapshot wins', () => {
    const older = snapshot('2026-11-04T13:00:00Z', 10);
    const newer = snapshot('2026-11-04T14:00:00Z', 40);
    expect(shownUsage(newer, older)).toBe(newer);
    expect(shownUsage(older, newer)).toBe(newer);
    expect(shownUsage(null, older)).toBe(older);
    expect(shownUsage(undefined, null)).toBeNull();
  });

  test('a reset today is a clock time; within a week a weekday; later a date', () => {
    const now = Date.parse('2026-11-04T09:00:00');
    expect(formatReset('2026-11-04T16:10:00', now, 'en-GB')).toBe('16:10');
    expect(formatReset('2026-11-06T09:00:00', now, 'en-GB')).toBe('Fri 09:00');
    expect(formatReset('2026-11-20T09:00:00', now, 'en-GB')).toBe('20 Nov');
  });
});
