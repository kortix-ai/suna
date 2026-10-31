import { describe, expect, test } from 'bun:test';

import type { InboxNotification } from '@kortix/sdk';

import {
  badgeCount,
  filterRows,
  nextFilter,
  targetOf,
  toInboxRow,
  webUrlOf,
  withoutNotificationParam,
} from './inbox-model.ts';

function note(overrides: Partial<InboxNotification> = {}): InboxNotification {
  return {
    id: 'n-1',
    kind: 'question',
    title: 'Which bank?',
    body: 'Pick one\nof two',
    project_id: 'p-1',
    project_name: 'Atlas',
    session_id: 's-1',
    trigger_slug: null,
    actor_user_id: null,
    url: '/projects/p-1/sessions/s-1?notification=n-1',
    read: false,
    created_at: '2026-09-17T11:57:00Z',
    ...overrides,
  };
}

describe('toInboxRow', () => {
  test('names the kind, marks needs-you kinds and parses the time', () => {
    const row = toInboxRow(note());
    expect(row).toMatchObject({
      id: 'n-1',
      kind: 'Question',
      glyph: '?',
      needsYou: true,
      read: false,
      projectName: 'Atlas',
    });
    expect(row.createdMs).toBe(Date.parse('2026-09-17T11:57:00Z'));
  });

  test('turn_done is not a needs-you kind', () => {
    expect(toInboxRow(note({ kind: 'turn_done' })).needsYou).toBe(false);
  });

  test('an empty title falls back to the kind word', () => {
    expect(toInboxRow(note({ title: '', kind: 'shared' })).title).toBe('Shared with you');
  });
});

describe('filterRows', () => {
  const rows = [
    toInboxRow(note({ id: 'a', kind: 'turn_done', read: true })),
    toInboxRow(note({ id: 'b', kind: 'question', read: true })),
    toInboxRow(note({ id: 'c', kind: 'turn_error', read: false })),
    toInboxRow(note({ id: 'd', kind: 'shared', read: false })),
  ];

  test('all keeps the inbox order', () => {
    expect(filterRows(rows, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('unread drops read rows', () => {
    expect(filterRows(rows, 'unread').map((r) => r.id)).toEqual(['c', 'd']);
  });

  test('needs keeps needs-you kinds, unread first', () => {
    expect(filterRows(rows, 'needs').map((r) => r.id)).toEqual(['c', 'b']);
  });

  test('the filter cycles all, unread, needs, all', () => {
    expect(nextFilter('all')).toBe('unread');
    expect(nextFilter('unread')).toBe('needs');
    expect(nextFilter('needs')).toBe('all');
  });
});

describe('targetOf', () => {
  const web = 'https://dev.kortix.com/';

  test('a session of the current project opens in the TUI', () => {
    expect(targetOf(toInboxRow(note()), 'p-1', web)).toEqual({ kind: 'session', sessionId: 's-1' });
  });

  test('a session of another project opens on the web, without the notification param', () => {
    expect(targetOf(toInboxRow(note()), 'p-2', web)).toEqual({
      kind: 'web',
      url: 'https://dev.kortix.com/projects/p-1/sessions/s-1',
    });
  });

  test('a row with no session opens its web path', () => {
    const row = toInboxRow(
      note({ session_id: null, url: '/projects/p-1/triggers?notification=n-1&tab=x' }),
    );
    expect(targetOf(row, 'p-1', web)).toEqual({
      kind: 'web',
      url: 'https://dev.kortix.com/projects/p-1/triggers?tab=x',
    });
  });
});

describe('helpers', () => {
  test('withoutNotificationParam strips only that param', () => {
    expect(withoutNotificationParam('/a?notification=1&x=2#h')).toBe('/a?x=2#h');
  });

  test('webUrlOf trims a trailing slash on the origin', () => {
    expect(webUrlOf('/a', 'https://x.test///')).toBe('https://x.test/a');
  });

  test('badgeCount clamps at 99+', () => {
    expect([badgeCount(3), badgeCount(99), badgeCount(100)]).toEqual(['3', '99', '99+']);
  });
});
