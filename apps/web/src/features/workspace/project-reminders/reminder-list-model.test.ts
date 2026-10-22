import type { ProjectReminder } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { rowsForTab, selectionState, toggleSelection } from './reminder-list-model';
import { createRemindersUrlStore, remindersQuery } from './use-reminders-url-state';

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

describe('selection', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const sorted = (set: Set<string>) => [...set].sort();

  test('a press toggles one row', () => {
    const one = toggleSelection(new Set(), ids, 'b', null);
    expect(sorted(one)).toEqual(['b']);
    expect(sorted(toggleSelection(one, ids, 'b', 'b'))).toEqual([]);
  });

  test('a shift-press sets the range from the anchor to the pressed row, either direction', () => {
    expect(sorted(toggleSelection(new Set(['b']), ids, 'd', 'b'))).toEqual(['b', 'c', 'd']);
    expect(sorted(toggleSelection(new Set(['d']), ids, 'a', 'd'))).toEqual(['a', 'b', 'c', 'd']);
    // Shift-pressing a selected row clears the range instead.
    expect(sorted(toggleSelection(new Set(ids), ids, 'd', 'b'))).toEqual(['a', 'e']);
  });

  test('an anchor that left the list falls back to one row', () => {
    expect(sorted(toggleSelection(new Set(), ids, 'c', 'gone'))).toEqual(['c']);
  });

  test('header state counts only the rows on screen', () => {
    expect(selectionState(new Set(), ids)).toBe('none');
    expect(selectionState(new Set(['a', 'gone']), ids)).toBe('some');
    expect(selectionState(new Set([...ids, 'gone']), ids)).toBe('all');
    expect(selectionState(new Set(), [])).toBe('none');
  });
});

describe('remindersQuery', () => {
  test('sets, replaces and drops params; defaults leave the URL', () => {
    // Calendar is the default view: only List is written.
    expect(remindersQuery('', { view: 'list' })).toBe('view=list');
    expect(remindersQuery('view=list&session=s1', { view: 'calendar' })).toBe('session=s1');
    expect(remindersQuery('session=s1', { session: null })).toBe('');
    expect(remindersQuery('session=s1', { range: 'month', date: undefined })).toBe(
      'session=s1&range=month',
    );
    expect(remindersQuery('range=month', { range: 'week' })).toBe('');
  });
});

describe('createRemindersUrlStore', () => {
  test('set changes the query at once; a late echo of an earlier write never undoes a newer one', () => {
    const replaced: string[] = [];
    (globalThis as { window?: unknown }).window = {
      location: { pathname: '/r', search: '' },
      history: {
        state: { __NA: true },
        replaceState: (_: unknown, __: string, url: string) => replaced.push(url),
      },
    };
    const store = createRemindersUrlStore('');
    store.set({ view: 'list' });
    store.set({ session: 's9' });
    expect(store.query()).toBe('view=list&session=s9');
    expect(replaced).toEqual(['/r?view=list', '/r?view=list&session=s9']);
    // Next reports the first write back after the second: ignored.
    store.sync('view=list');
    expect(store.query()).toBe('view=list&session=s9');
    // A link to this page with params the store never wrote: taken.
    store.sync('range=month&session=s1');
    expect(store.query()).toBe('range=month&session=s1');
    delete (globalThis as { window?: unknown }).window;
  });
});
