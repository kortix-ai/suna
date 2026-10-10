import { describe, expect, test } from 'bun:test';
import { formatFireTime, nearestFire, reminderTitle, soonestFire } from './reminder-format';

const NOW = Date.parse('2026-09-29T10:00:00.000Z');

describe('formatFireTime', () => {
  test('relative inside a day, both directions', () => {
    expect(formatFireTime('2026-09-29T10:12:00.000Z', 'en', NOW)).toBe('in 12 min.');
    expect(formatFireTime('2026-09-29T13:00:00.000Z', 'en', NOW)).toBe('in 3 hr.');
    expect(formatFireTime('2026-09-29T09:55:00.000Z', 'en', NOW)).toBe('5 min. ago');
  });

  test('a weekday within the week, a date past it', () => {
    expect(formatFireTime('2026-10-01T09:00:00.000Z', 'en', NOW)).toMatch(/^Thu /);
    expect(formatFireTime('2026-10-20T09:00:00.000Z', 'en', NOW)).toMatch(/^Oct 20/);
  });

  test('an unparseable value renders nothing', () => {
    expect(formatFireTime('nope', 'en', NOW)).toBe('');
  });
});

describe('soonestFire', () => {
  test('only active reminders with a scheduled fire count', () => {
    expect(
      soonestFire([
        { state: 'paused', next_fire_at: null },
        { state: 'active', next_fire_at: '2026-09-29T12:00:00.000Z' },
        { state: 'active', next_fire_at: '2026-09-29T11:00:00.000Z' },
        { state: 'done', next_fire_at: null },
      ]),
    ).toBe(Date.parse('2026-09-29T11:00:00.000Z'));
    expect(soonestFire([{ state: 'paused', next_fire_at: null }])).toBeNull();
  });
});

describe('nearestFire', () => {
  const at = (iso: string) => Date.parse(iso);
  test('the soonest upcoming fire first', () => {
    expect(
      nearestFire([
        { state: 'done', next_fire_at: null, last_fired_at: '2026-10-01T10:00:00Z', at: null },
        { state: 'active', next_fire_at: '2026-11-20T08:00:00Z', last_fired_at: null, at: null },
      ]),
    ).toBe(at('2026-11-20T08:00:00Z'));
  });

  test('else the latest fire that happened, else a paused next slot', () => {
    expect(
      nearestFire([
        { state: 'done', next_fire_at: null, last_fired_at: '2026-09-01T10:00:00Z', at: null },
        { state: 'done', next_fire_at: null, last_fired_at: '2026-10-01T10:00:00Z', at: null },
        { state: 'paused', next_fire_at: '2026-12-01T10:00:00Z', last_fired_at: null, at: null },
      ]),
    ).toBe(at('2026-10-01T10:00:00Z'));
    expect(
      nearestFire([
        { state: 'paused', next_fire_at: '2026-12-01T10:00:00Z', last_fired_at: null, at: null },
      ]),
    ).toBe(at('2026-12-01T10:00:00Z'));
    // A paused one-shot keeps its scheduled time in `at`, not `next_fire_at`.
    expect(
      nearestFire([
        { state: 'paused', next_fire_at: null, last_fired_at: null, at: '2026-10-07T18:00:00Z' },
      ]),
    ).toBe(at('2026-10-07T18:00:00Z'));
    expect(
      nearestFire([{ state: 'done', next_fire_at: null, last_fired_at: null, at: null }]),
    ).toBeNull();
  });
});

describe('reminderTitle', () => {
  test('the name wins; otherwise the first line of the text', () => {
    expect(reminderTitle({ name: 'Vendor', prompt: 'x' })).toBe('Vendor');
    expect(reminderTitle({ name: null, prompt: '  Did it arrive?\nThen act.' })).toBe(
      'Did it arrive?',
    );
  });
});
