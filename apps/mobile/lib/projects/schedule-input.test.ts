import { describe, expect, test } from 'bun:test';

import { normalizeCron, toFiveFieldCron, deviceTimezone, timezoneOptions } from './schedule-input';
import { CRON_PRESETS, TIMEZONES } from './triggers-format';

describe('normalizeCron', () => {
  test('a 5-field cron gains a zero seconds field', () => {
    expect(normalizeCron('0 9 * * *')).toEqual({ ok: true, cron: '0 0 9 * * *' });
    expect(normalizeCron('*/15 * * * *')).toEqual({ ok: true, cron: '0 */15 * * * *' });
    expect(normalizeCron('0 9 * * MON-FRI')).toEqual({ ok: true, cron: '0 0 9 * * MON-FRI' });
  });

  test('a 5-field cron normalizes to the matching 6-field preset', () => {
    for (const preset of CRON_PRESETS) {
      expect(normalizeCron(toFiveFieldCron(preset.cron))).toEqual({ ok: true, cron: preset.cron });
    }
  });

  test('a 6-field cron passes through; extra whitespace collapses', () => {
    expect(normalizeCron('30 0 9 * * 1-5')).toEqual({ ok: true, cron: '30 0 9 * * 1-5' });
    expect(normalizeCron('  0   9 * *  * ')).toEqual({ ok: true, cron: '0 0 9 * * *' });
  });

  test('croner nicknames pass through lowercased', () => {
    expect(normalizeCron('@Daily')).toEqual({ ok: true, cron: '@daily' });
    expect(normalizeCron('@sometimes')).toEqual({ ok: false, error: 'Unknown schedule "@sometimes"' });
  });

  test('empty and wrong field counts fail with the format', () => {
    expect(normalizeCron('')).toEqual({ ok: false, error: 'Enter a schedule' });
    const four = normalizeCron('*/5 * * *');
    expect(four.ok).toBe(false);
    if (!four.ok) expect(four.error).toContain('minute hour day month weekday');
    expect(normalizeCron('0 0 9 * * 1-5 2030').ok).toBe(false);
  });

  test('out-of-range values name the field', () => {
    expect(normalizeCron('60 * * * *')).toEqual({ ok: false, error: 'Minute must be 0–59 (got "60")' });
    expect(normalizeCron('0 24 * * *')).toEqual({ ok: false, error: 'Hour must be 0–23 (got "24")' });
    expect(normalizeCron('0 9 0 * *')).toEqual({ ok: false, error: 'Day of month must be 1–31 (got "0")' });
    expect(normalizeCron('0 9 * 13 *')).toEqual({ ok: false, error: 'Month must be 1–12 (got "13")' });
    expect(normalizeCron('0 9 * * 8')).toEqual({ ok: false, error: 'Weekday must be 0–7 (got "8")' });
  });

  test('lists, ranges, steps, names and day forms', () => {
    expect(normalizeCron('0,30 9-17 * JAN,JUL SUN').ok).toBe(true);
    expect(normalizeCron('0 9 ? * *').ok).toBe(true);
    expect(normalizeCron('0 9 L * *').ok).toBe(true);
    expect(normalizeCron('0 9 * * 5#2').ok).toBe(true);
    expect(normalizeCron('0 17-9 * * *')).toEqual({ ok: false, error: 'Hour range "17-9" runs backwards' });
    expect(normalizeCron('*/0 * * * *')).toEqual({ ok: false, error: 'Minute step must be 1 or more' });
    expect(normalizeCron('0 9 ? * ?').ok).toBe(true);
    expect(normalizeCron('? 9 * * *').ok).toBe(false);
    expect(normalizeCron('0 9 * * FOO').ok).toBe(false);
    expect(normalizeCron('0,,5 9 * * *').ok).toBe(false);
  });
});

describe('toFiveFieldCron', () => {
  test('drops a zero seconds field only', () => {
    expect(toFiveFieldCron('0 0 9 * * *')).toBe('0 9 * * *');
    expect(toFiveFieldCron('30 0 9 * * *')).toBe('30 0 9 * * *');
    expect(toFiveFieldCron('0 9 * * *')).toBe('0 9 * * *');
    expect(toFiveFieldCron('@daily')).toBe('@daily');
  });
});

describe('deviceTimezone', () => {
  test('returns the resolved IANA zone', () => {
    expect(deviceTimezone(() => 'Asia/Kolkata')).toBe('Asia/Kolkata');
  });

  test('falls back to UTC when Intl has no zone or throws', () => {
    expect(deviceTimezone(() => undefined)).toBe('UTC');
    expect(deviceTimezone(() => '  ')).toBe('UTC');
    expect(
      deviceTimezone(() => {
        throw new Error('no Intl');
      }),
    ).toBe('UTC');
  });

  test('the default reads Intl and returns a non-empty zone', () => {
    expect(deviceTimezone().length).toBeGreaterThan(0);
  });
});

describe('timezoneOptions', () => {
  test('keeps the list when it has the device zone', () => {
    expect(timezoneOptions('Europe/Berlin')).toEqual(TIMEZONES);
  });

  test('puts a missing device zone first', () => {
    const options = timezoneOptions('Europe/Madrid');
    expect(options[0]).toBe('Europe/Madrid');
    expect(options.slice(1)).toEqual(TIMEZONES);
  });
});
