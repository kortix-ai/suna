import { describe, expect, test } from 'bun:test';
import type { ProjectReminder } from '@kortix/sdk';
import { heatLevel, RAIL_DAYS, railModel, rowsForTab } from './reminder-list-model';
import { remindersQuery } from './use-reminders-url-state';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A Wednesday, local noon: today is index 2 of the Monday-first week.
const NOW = new Date(2026, 8, 30, 12, 0, 0).getTime();

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
const ids = (rows: ProjectReminder[]) => rows.map((row) => row.id);

describe('rowsForTab', () => {
  test('active: soonest next fire first, missing next fire last', () => {
    const rows = rowsForTab(
      [
        reminder({ id: 'late', next_fire_at: iso(NOW + 2 * HOUR) }),
        reminder({ id: 'none' }),
        reminder({ id: 'soon', next_fire_at: iso(NOW + HOUR) }),
        reminder({ id: 'paused', state: 'paused', next_fire_at: iso(NOW) }),
      ],
      'active',
    );
    expect(ids(rows)).toEqual(['soon', 'late', 'none']);
  });

  test('paused: newest created first', () => {
    const rows = rowsForTab(
      [
        reminder({ id: 'old', state: 'paused', created_at: iso(NOW - 2 * DAY) }),
        reminder({ id: 'new', state: 'paused', created_at: iso(NOW - DAY) }),
      ],
      'paused',
    );
    expect(ids(rows)).toEqual(['new', 'old']);
  });

  test('done: latest fire first, never-fired last', () => {
    const rows = rowsForTab(
      [
        reminder({ id: 'never', state: 'done' }),
        reminder({ id: 'old', state: 'done', last_fired_at: iso(NOW - 2 * DAY) }),
        reminder({ id: 'new', state: 'done', last_fired_at: iso(NOW - DAY) }),
      ],
      'done',
    );
    expect(ids(rows)).toEqual(['new', 'old', 'never']);
  });
});

describe('railModel', () => {
  test('starts on this week Monday and counts only upcoming fires', () => {
    const daily = reminder({
      id: 'daily',
      every_seconds: 86_400,
      next_fire_at: iso(NOW + HOUR),
      last_fired_at: iso(NOW - 23 * HOUR),
    });
    const model = railModel([daily], NOW);
    expect(new Date(model.start).getDay()).toBe(1);
    expect(model.today).toBe(2);
    expect(model.counts).toHaveLength(RAIL_DAYS);
    // Monday and Tuesday are past: no fabricated history.
    expect(model.counts.slice(0, 2)).toEqual([0, 0]);
    expect(model.counts[2]).toBe(1);
    expect(model.total).toBe(RAIL_DAYS - 2);
    expect(model.frequent).toEqual([{ reminder: daily, count: 14 }]);
  });

  test('the 5-minute floor is counted in full, not capped per call', () => {
    const tomorrow = new Date(2026, 9, 1).getTime();
    const busy = reminder({ id: 'busy', every_seconds: 300, next_fire_at: iso(tomorrow) });
    const model = railModel([busy], NOW);
    expect(model.counts[3]).toBe(288);
    expect(model.total).toBe(model.counts.reduce((sum, count) => sum + count, 0));
    expect(model.total).toBeGreaterThan(2000);
  });

  test('paused reminders and fires beyond the grid add nothing; top 3 by count', () => {
    const model = railModel(
      [
        reminder({ id: 'paused', state: 'paused', every_seconds: 3600, next_fire_at: iso(NOW + HOUR) }),
        reminder({ id: 'far', next_fire_at: iso(NOW + 60 * DAY) }),
        reminder({ id: 'a', every_seconds: 86_400, next_fire_at: iso(NOW + HOUR) }),
        reminder({ id: 'b', every_seconds: 43_200, next_fire_at: iso(NOW + HOUR) }),
        reminder({ id: 'c', next_fire_at: iso(NOW + HOUR) }),
        reminder({ id: 'd', every_seconds: 21_600, next_fire_at: iso(NOW + HOUR) }),
      ],
      NOW,
    );
    expect(model.frequent.map((entry) => entry.reminder.id)).toEqual(['d', 'b', 'a']);
  });

  test('cron reminders are left out of every count and flagged', () => {
    const daily = reminder({ id: 'daily', every_seconds: 86_400, next_fire_at: iso(NOW + HOUR) });
    const cron = reminder({ id: 'cron', cron: '0 9 * * *', timezone: 'UTC', next_fire_at: iso(NOW + 2 * HOUR) });
    const model = railModel([daily, cron], NOW);
    expect(model.hasCron).toBe(true);
    expect(model.total).toBe(RAIL_DAYS - 2);
    expect(model.counts[2]).toBe(1);
    expect(model.frequent.map((entry) => entry.reminder.id)).toEqual(['daily']);
    expect(railModel([daily], NOW).hasCron).toBe(false);
  });

  test('no active reminders: zero fires', () => {
    const model = railModel([reminder({ state: 'done', last_fired_at: iso(NOW - HOUR) })], NOW);
    expect(model.total).toBe(0);
    expect(model.frequent).toEqual([]);
  });
});

describe('heatLevel', () => {
  test('0 for no fire, 1-4 relative to the busiest day', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(8, 10)).toBe(4);
    expect(heatLevel(10, 10)).toBe(4);
  });
});

describe('remindersQuery', () => {
  test('sets, replaces and drops params; defaults leave the URL', () => {
    expect(remindersQuery('', { view: 'calendar' })).toBe('view=calendar');
    expect(remindersQuery('view=calendar&session=s1', { view: 'list' })).toBe('session=s1');
    expect(remindersQuery('session=s1', { session: null })).toBe('');
    expect(remindersQuery('session=s1', { range: 'month', date: undefined })).toBe('session=s1&range=month');
    expect(remindersQuery('range=month', { range: 'week' })).toBe('');
  });
});
