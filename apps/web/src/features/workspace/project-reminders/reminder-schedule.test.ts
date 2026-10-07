import { describe, expect, test } from 'bun:test';
import type { ProjectReminder } from '@kortix/sdk';
import { expandFires, expandSteps, firesPerDay, isFrequent } from './reminder-schedule';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-29T10:00:00.000Z');

function reminder(over: Partial<ProjectReminder>): ProjectReminder {
  return {
    id: 'r1',
    session_id: 's1',
    session_name: null,
    name: null,
    prompt: 'ping',
    every: null,
    every_seconds: null,
    cron: null,
    timezone: null,
    at: null,
    state: 'active',
    next_fire_at: null,
    last_fired_at: null,
    last_status: null,
    last_error: null,
    created_by: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  } as ProjectReminder;
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('expandFires', () => {
  test('interval reminder steps forward and backward from next_fire_at', () => {
    const next = NOW + HOUR;
    const r = reminder({ every_seconds: 3600, next_fire_at: iso(next) });
    const fires = expandFires([r], NOW - 2 * HOUR, NOW + 3 * HOUR, NOW);
    expect(fires.map((f) => f.at)).toEqual([
      NOW - 2 * HOUR,
      NOW - HOUR,
      NOW,
      NOW + HOUR,
      NOW + 2 * HOUR,
    ]);
    expect(fires.map((f) => f.past)).toEqual([true, true, true, false, false]);
  });

  test('backward steps stop at created_at', () => {
    const r = reminder({
      every_seconds: 3600,
      next_fire_at: iso(NOW + HOUR),
      created_at: iso(NOW - 30 * 60_000),
    });
    const fires = expandFires([r], NOW - 5 * HOUR, NOW + HOUR + 1, NOW);
    expect(fires.map((f) => f.at)).toEqual([NOW, NOW + HOUR]);
  });

  test('caps at 2000 fires per reminder', () => {
    const r = reminder({ every_seconds: 1, next_fire_at: iso(NOW + 1000) });
    expect(expandFires([r], NOW, NOW + 10 * HOUR, NOW)).toHaveLength(2000);
  });

  test('cron reminder emits only next_fire_at', () => {
    const next = NOW + 5 * HOUR;
    const r = reminder({ cron: '0 15 * * *', next_fire_at: iso(next) });
    const fires = expandFires([r], NOW - 48 * HOUR, NOW + 48 * HOUR, NOW);
    expect(fires.map((f) => f.at)).toEqual([next]);
  });

  test('one-shot emits next_fire_at once', () => {
    const next = NOW + 2 * HOUR;
    const r = reminder({ at: iso(next), next_fire_at: iso(next) });
    expect(expandFires([r], NOW, NOW + 24 * HOUR, NOW).map((f) => f.at)).toEqual([next]);
  });

  test('paused emits only last_fired_at as past', () => {
    const last = NOW - HOUR;
    const r = reminder({
      state: 'paused',
      every_seconds: 3600,
      next_fire_at: iso(NOW + HOUR),
      last_fired_at: iso(last),
    });
    const fires = expandFires([r], NOW - 5 * HOUR, NOW + 5 * HOUR, NOW);
    expect(fires).toHaveLength(1);
    expect(fires[0]).toMatchObject({ at: last, past: true });
  });

  test('last_fired_at is not duplicated and respects range', () => {
    const r = reminder({
      every_seconds: 3600,
      next_fire_at: iso(NOW + HOUR),
      last_fired_at: iso(NOW),
    });
    const fires = expandFires([r], NOW - HOUR, NOW + 2 * HOUR, NOW);
    expect(fires.filter((f) => f.at === NOW)).toHaveLength(1);
    expect(fires.filter((f) => f.confirmed).map((f) => f.at)).toEqual([NOW]);
    const outside = reminder({ state: 'done', last_fired_at: iso(NOW - 10 * HOUR) });
    expect(expandFires([outside], NOW - HOUR, NOW + HOUR, NOW)).toEqual([]);
  });

  test('last_fired_at seconds after its grid slot replaces that slot', () => {
    const next = NOW + HOUR;
    const last = next - HOUR + 3_000;
    const r = reminder({ every_seconds: 3600, next_fire_at: iso(next), last_fired_at: iso(last) });
    const fires = expandFires([r], NOW - 2 * HOUR, NOW + 2 * HOUR, NOW + 5_000);
    expect(fires.map((f) => [f.at, f.confirmed])).toEqual([
      [NOW - 2 * HOUR, false],
      [NOW - HOUR, false],
      [last, true],
      [next, false],
    ]);
  });

  test('only last_fired_at is confirmed; inferred past fires are not', () => {
    const r = reminder({ every_seconds: 3600, next_fire_at: iso(NOW + HOUR) });
    const fires = expandFires([r], NOW - 2 * HOUR, NOW, NOW);
    expect(fires.map((f) => [f.past, f.confirmed])).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  test('past flag is at <= now; result sorted across reminders', () => {
    const a = reminder({ id: 'a', at: iso(NOW), next_fire_at: iso(NOW) });
    const b = reminder({ id: 'b', at: iso(NOW - HOUR), next_fire_at: iso(NOW - HOUR) });
    const fires = expandFires([a, b], NOW - 2 * HOUR, NOW + HOUR, NOW);
    expect(fires.map((f) => [f.reminder.id, f.past])).toEqual([
      ['b', true],
      ['a', true],
    ]);
  });

  test('a window months in the past is expanded from its own end, not from now', () => {
    const MIN = 60_000;
    const r = reminder({
      every_seconds: 60,
      next_fire_at: iso(NOW + 30_000),
      created_at: iso(NOW - 200 * 24 * HOUR),
    });
    // One hour, ~3 months back: 60 fires, all past, on the minute grid.
    const from = NOW - 90 * 24 * HOUR + 30_000;
    const fires = expandFires([r], from, from + HOUR, NOW);
    expect(fires).toHaveLength(60);
    expect(fires[0]!.at).toBe(from);
    expect(fires[59]!.at).toBe(from + 59 * MIN);
    expect(fires.every((f) => f.past)).toBe(true);
    // Bounded work: walking from now back to the window is ~130k steps.
    // From the window's end it is the 60 fires plus a boundary step or two.
    expect(expandSteps).toBeLessThanOrEqual(62);
  });
});

describe('firesPerDay / isFrequent', () => {
  test('interval gives 86400 / every_seconds, others null', () => {
    expect(firesPerDay(reminder({ every_seconds: 21_600 }))).toBe(4);
    expect(firesPerDay(reminder({ cron: '* * * * *' }))).toBeNull();
    expect(firesPerDay(reminder({}))).toBeNull();
  });

  test('frequent means more than 4 per day', () => {
    expect(isFrequent(reminder({ every_seconds: 6 * 3600 }))).toBe(false);
    expect(isFrequent(reminder({ every_seconds: 2 * 3600 }))).toBe(true);
    expect(isFrequent(reminder({ cron: '0 * * * *' }))).toBe(false);
  });
});
