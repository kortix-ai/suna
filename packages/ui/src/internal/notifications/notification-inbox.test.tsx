import { describe, expect, test } from 'bun:test';
import type { InboxNotification } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotificationInboxView, type NotificationInboxViewProps } from './notification-inbox';

/** The Inbox page's props-only half, rendered statically (KRTX-1742). */

const unread: InboxNotification = {
  id: '0192f0c4-0000-7000-8000-000000000001',
  kind: 'question',
  title: 'Release notes',
  body: 'Continue with the changelog?',
  project_id: 'p1',
  project_name: 'Website',
  session_id: 'ses-b',
  trigger_slug: null,
  actor_user_id: null,
  url: '/projects/p1/sessions/ses-b?notification=0192f0c4-0000-7000-8000-000000000001',
  read: false,
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
};
const read: InboxNotification = {
  ...unread,
  id: '0192f0c4-0000-7000-8000-000000000002',
  kind: 'automation_failed',
  title: 'Nightly report',
  body: '',
  session_id: null,
  trigger_slug: 'nightly-report',
  url: '/projects/p1/admin/triggers?notification=0192f0c4-0000-7000-8000-000000000002',
  read: true,
};
const done: InboxNotification = {
  ...unread,
  id: '0192f0c4-0000-7000-8000-000000000003',
  kind: 'turn_done',
  title: 'Weekly digest',
  body: '',
  session_id: 'ses-c',
  url: '/projects/p1/sessions/ses-c?notification=0192f0c4-0000-7000-8000-000000000003',
};

function render(overrides: Partial<NotificationInboxViewProps> = {}) {
  return renderToStaticMarkup(
    <NotificationInboxView
      rows={[unread, read, done]}
      state="ready"
      unreadCount={2}
      prompt={null}
      settings={{ href: '/settings/sessions' }}
      onOpenRow={() => {}}
      onMarkAllRead={() => {}}
      onRetry={() => {}}
      onTurnOn={() => {}}
      onDismissPrompt={() => {}}
      {...overrides}
    />,
  );
}

/** The text of each tab trigger, badge included: "Needs you1". */
const tabs = (html: string) =>
  [...html.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));

describe('NotificationInboxView', () => {
  test('the page is titled Inbox, with one line under the title', () => {
    const out = render();
    // Inside a project: the project page header (the desktop title-bar row) holds the title.
    expect([...out.matchAll(/<h1[^>]*>Inbox<\/h1>/g)]).toHaveLength(1);
    expect(out).toContain('kx-titlebar-row');
    expect(out).toContain('that concern you, from every workspace.');
  });

  test('outside a project the host header leads and the column carries the title', () => {
    const out = render({ header: <div data-testid="account-top-bar" /> });
    expect(out.indexOf('data-testid="account-top-bar"')).toBeLessThan(out.indexOf('>Inbox</h1>'));
    expect([...out.matchAll(/<h1[^>]*>Inbox<\/h1>/g)]).toHaveLength(1);
    expect(out).not.toContain('kx-titlebar-row');
  });

  test('the tabs carry their unread counts: All, Needs you, Done', () => {
    expect(tabs(render())).toEqual(['All2', 'Needs you1', 'Done1']);
    // Nothing unread: no count on any tab.
    expect(tabs(render({ rows: [read], unreadCount: 0 }))).toEqual(['All', 'Needs you', 'Done']);
  });

  test('a row shows its subject, its detail, its kind, its project and its age', () => {
    const out = render();
    expect(out).toContain('>Release notes<');
    expect(out).toContain('>Continue with the changelog?<');
    expect(out).toContain('>Question<');
    expect(out).toContain('>Website<');
    expect(out).toContain('5m ago');
    expect(out).toContain('>Failure alert<');
  });

  test('a row links to its subject without the read marker: the click marks it read', () => {
    const out = render();
    expect(out).toContain('href="/projects/p1/sessions/ses-b"');
    expect(out).toContain('href="/projects/p1/admin/triggers"');
    expect(out).not.toContain('notification=');
  });

  test('only unread rows carry the unread mark, and they come first', () => {
    const out = render();
    expect([...out.matchAll(/data-unread=""/g)]).toHaveLength(2);
    expect([...out.matchAll(/>Unread</g)]).toHaveLength(2);
    expect(out.indexOf('Weekly digest')).toBeLessThan(out.indexOf('Nightly report'));
  });

  test('"Mark all as read" shows only while something is unread', () => {
    expect(render()).toContain('Mark all as read');
    expect(render({ unreadCount: 0, rows: [read] })).not.toContain('Mark all as read');
  });

  test('an empty inbox is the empty state: one title, one sentence', () => {
    const out = render({ rows: [], unreadCount: 0 });
    expect(out).toContain('Notifications will show up here');
    expect(out).toContain('Kortix notifies you when a session finishes');
    expect(out).not.toContain('href="/projects/');
  });

  test('a failed load says so and offers to try again', () => {
    const out = render({ state: 'error', rows: [] });
    expect(out).toContain('Could not load notifications');
    expect(out).toContain('Try again');
  });

  test('while loading no row and no empty state render', () => {
    const out = render({ state: 'loading', rows: [] });
    expect(out).not.toContain('href="/projects/');
    expect(out).not.toContain('Notifications will show up here');
    // Three skeleton rows: the row shape is known.
    expect([...out.matchAll(/animate-pulse/g)]).toHaveLength(3);
  });

  test('the offer to turn browser notifications on shows when it applies, and can be dismissed', () => {
    expect(render()).not.toContain('Turn on');
    const out = render({ prompt: 'Get notified when Kortix is closed' });
    expect(out).toContain('Get notified when Kortix is closed');
    expect(out).toContain('>Turn on<');
    expect(out).toContain('aria-label="Dismiss"');
  });

  test('the footer says email is opt-in and links to the per-kind settings', () => {
    const out = render();
    expect(out).toContain('Email is off for most kinds until you turn it on.');
    expect(out).toContain('href="/settings/sessions"');
    expect(out).toContain('Notification settings');
    // Inside a project, the button opens the Settings overlay: no link.
    const overlay = render({ settings: { onOpen: () => {} } });
    expect(overlay).toContain('Notification settings');
    expect(overlay).not.toContain('href="/settings/sessions"');
  });
});
