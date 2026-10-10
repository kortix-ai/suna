import type { ProjectReminder } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { rowsForTab } from './reminder-list-model';
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

describe('remindersQuery', () => {
  test('sets, replaces and drops params; defaults leave the URL', () => {
    expect(remindersQuery('', { view: 'calendar' })).toBe('view=calendar');
    expect(remindersQuery('view=calendar&session=s1', { view: 'list' })).toBe('session=s1');
    expect(remindersQuery('session=s1', { session: null })).toBe('');
    expect(remindersQuery('session=s1', { range: 'month', date: undefined })).toBe(
      'session=s1&range=month',
    );
    expect(remindersQuery('range=month', { range: 'week' })).toBe('');
  });
});
