import { describe, expect, test } from 'bun:test';
import type { InboxNotification } from '@kortix/sdk';
import {
  MAX_ARRIVAL_ALERTS,
  badgeCount,
  isNotificationId,
  newArrivals,
  notificationTag,
  openedNotificationId,
  planArrivals,
  pollsWhileHidden,
  rowDestination,
  sessionUnreadRowId,
  webNotificationType,
  withoutNotificationParam,
} from './notification-rows';

let next = 0;
function row(overrides: Partial<InboxNotification> = {}): InboxNotification {
  next += 1;
  return {
    id: `0192f0c4-0000-7000-8000-${String(next).padStart(12, '0')}`,
    kind: 'question',
    title: 'Release notes',
    body: 'Continue?',
    project_id: 'p1',
    project_name: 'Website',
    session_id: 'ses-b',
    trigger_slug: null,
    actor_user_id: null,
    url: `/projects/p1/sessions/ses-b?notification=n${next}`,
    read: false,
    created_at: '2026-10-09T10:00:00.000Z',
    ...overrides,
  };
}

describe('withoutNotificationParam', () => {
  test('drops only the notification key', () => {
    expect(withoutNotificationParam('/projects/p1/sessions/s?notification=n1')).toBe(
      '/projects/p1/sessions/s',
    );
    expect(withoutNotificationParam('/projects/p1?a=1&notification=n1&b=2#top')).toBe(
      '/projects/p1?a=1&b=2#top',
    );
    expect(withoutNotificationParam('/projects/p1/customize/triggers')).toBe(
      '/projects/p1/customize/triggers',
    );
  });
});

test('only a uuid is a notification id', () => {
  expect(isNotificationId('0192f0c4-0000-7000-8000-000000000001')).toBe(true);
  expect(isNotificationId('n1')).toBe(false);
  expect(isNotificationId("1' OR 1=1")).toBe(false);
  expect(isNotificationId(null)).toBe(false);
});

describe('newArrivals', () => {
  test('the first poll announces nothing: those rows were there before', () => {
    const rows = [row(), row()];
    const first = newArrivals(null, rows);
    expect(first.fresh).toEqual([]);
    expect([...first.seen]).toEqual(rows.map((r) => r.id));
  });

  test('a later poll announces each new unread row once', () => {
    const old = row();
    const first = newArrivals(null, [old]);
    const fresh = row();
    const readOne = row({ read: true });
    const second = newArrivals(first.seen, [fresh, readOne, old]);
    expect(second.fresh).toEqual([fresh]);
    expect(newArrivals(second.seen, [fresh, readOne, old]).fresh).toEqual([]);
  });
});

describe('planArrivals', () => {
  const context = { onScreen: () => false, unseen: [] as string[], os: false };

  test('toasts at most three rows per poll', () => {
    const fresh = [row(), row(), row(), row(), row()];
    const plan = planArrivals(fresh, context);
    expect(plan.toast).toEqual(fresh.slice(0, MAX_ARRIVAL_ALERTS));
    expect(plan.os).toEqual([]);
  });

  test('skips the session on screen and a finished turn the stream already announced', () => {
    const onScreen = row({ session_id: 'ses-open' });
    const announced = row({ session_id: 'ses-done', kind: 'turn_done' });
    const other = row({ session_id: 'ses-other' });
    const plan = planArrivals([onScreen, announced, other], {
      onScreen: (sessionId) => sessionId === 'ses-open',
      unseen: ['ses-done'],
      os: false,
    });
    expect(plan.toast).toEqual([other]);
  });

  test('an unseen finished turn hides only its turn_done row, not a later ask or error', () => {
    const done = row({ session_id: 'ses-a', kind: 'turn_done' });
    const ask = row({ session_id: 'ses-a', kind: 'question' });
    const permission = row({ session_id: 'ses-a', kind: 'permission' });
    const error = row({ session_id: 'ses-a', kind: 'turn_error' });
    const plan = planArrivals([done, ask, permission, error], { ...context, unseen: ['ses-a'] });
    expect(plan.toast).toEqual([ask, permission, error]);
  });

  test('an automation alert has no session and is always announced', () => {
    const alert = row({ kind: 'automation_failed', session_id: null, trigger_slug: 'nightly' });
    expect(planArrivals([alert], { ...context, onScreen: () => true }).toast).toEqual([alert]);
  });

  test('a renderer without Web Push in the background raises OS notifications instead', () => {
    const fresh = [row(), row()];
    expect(planArrivals(fresh, { ...context, os: true })).toEqual({ toast: [], os: fresh });
  });
});

describe('tags and types', () => {
  test('the tag matches the Web Push message: <type>:<session|project:trigger|id>', () => {
    expect(notificationTag(row({ kind: 'turn_done', session_id: 'ses-b' }))).toBe('completion:ses-b');
    expect(
      notificationTag(
        row({ kind: 'automation_failed', project_id: 'p1', session_id: null, trigger_slug: 'nightly' }),
      ),
    ).toBe('automation_failed:p1:nightly');
    const bare = row({ kind: 'shared', session_id: null });
    expect(notificationTag(bare)).toBe(`shared:${bare.id}`);
  });

  test('one trigger slug in two projects gives two tags: neither alert replaces the other', () => {
    const alert = { kind: 'automation_failed', session_id: null, trigger_slug: 'nightly' } as const;
    expect(notificationTag(row({ ...alert, project_id: 'p1' }))).not.toBe(
      notificationTag(row({ ...alert, project_id: 'p2' })),
    );
  });

  test('the in-page type is the push type of the kind', () => {
    expect(webNotificationType(row({ kind: 'turn_done' }))).toBe('completion');
    expect(webNotificationType(row({ kind: 'turn_error' }))).toBe('error');
    expect(webNotificationType(row({ kind: 'automation_recovered' }))).toBe('automation_recovered');
  });

  test('the open action names the page the row url opens', () => {
    expect(rowDestination(row({ session_id: 'ses-b' }))).toBe('session');
    const alert = { kind: 'automation_failed', session_id: null } as const;
    expect(
      rowDestination(row({ ...alert, trigger_slug: 'reminder.0a1b2c3d4e5f', url: '/projects/p1/reminders?notification=n1' })),
    ).toBe('reminders');
    expect(
      rowDestination(row({ ...alert, trigger_slug: 'nightly', url: '/projects/p1/customize/triggers?notification=n1' })),
    ).toBe('triggers');
  });

  test('the badge clamps at 99+', () => {
    expect(badgeCount(1)).toBe('1');
    expect(badgeCount(99)).toBe('99');
    expect(badgeCount(100)).toBe('99+');
  });
});

describe('openedNotificationId', () => {
  const id = '0192f0c4-0000-7000-8000-000000000009';
  const message = { type: 'kortix:notification-open', url: `https://app.example.test/projects/p1/sessions/s?notification=${id}` };

  test('reads the id from the service worker message', () => {
    expect(openedNotificationId(message)).toBe(id);
  });

  test('ignores another message, a url without an id, and a non-uuid id', () => {
    expect(openedNotificationId({ ...message, type: 'other' })).toBeNull();
    expect(openedNotificationId({ ...message, url: 'https://app.example.test/projects/p1' })).toBeNull();
    expect(openedNotificationId({ ...message, url: '/projects/p1?notification=n1' })).toBeNull();
    expect(openedNotificationId({ type: message.type })).toBeNull();
    expect(openedNotificationId(null)).toBeNull();
  });
});

describe('pollsWhileHidden', () => {
  const desktop = { hidden: true, subscribed: false, enabled: true, permission: 'granted' as const };

  test('a hidden window without Web Push checks the inbox', () => {
    expect(pollsWhileHidden(desktop)).toBe(true);
  });

  test('a visible window, a Web Push subscription, or notifications off or not granted: no check', () => {
    expect(pollsWhileHidden({ ...desktop, hidden: false })).toBe(false);
    expect(pollsWhileHidden({ ...desktop, subscribed: true })).toBe(false);
    expect(pollsWhileHidden({ ...desktop, enabled: false })).toBe(false);
    expect(pollsWhileHidden({ ...desktop, permission: 'default' })).toBe(false);
  });
});

test('sessionUnreadRowId is the newest unread row of that session', () => {
  const newest = row({ session_id: 'ses-a' });
  const older = row({ session_id: 'ses-a' });
  const rows = [row({ session_id: 'ses-a', read: true }), row({ session_id: 'ses-b' }), newest, older];
  expect(sessionUnreadRowId(rows, 'ses-a')).toBe(newest.id);
  expect(sessionUnreadRowId(rows, 'ses-c')).toBeNull();
  expect(sessionUnreadRowId(undefined, 'ses-a')).toBeNull();
});
