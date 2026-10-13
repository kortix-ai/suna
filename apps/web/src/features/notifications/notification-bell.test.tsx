import { describe, expect, test } from 'bun:test';
import type { InboxNotification } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotificationPanel, type NotificationPanelProps } from './notification-bell';

/**
 * The bell's popover renders through a portal, which a static render cannot
 * reach, so these tests render its content, `NotificationPanel`.
 */

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
  session_id: null,
  trigger_slug: 'nightly-report',
  url: '/projects/p1/customize/triggers?notification=0192f0c4-0000-7000-8000-000000000002',
  read: true,
};

function render(overrides: Partial<NotificationPanelProps> = {}) {
  return renderToStaticMarkup(
    <NotificationPanel
      rows={[unread, read]}
      state="ready"
      unreadCount={1}
      prompt={null}
      onOpenRow={() => {}}
      onMarkAllRead={() => {}}
      onRetry={() => {}}
      onTurnOn={() => {}}
      onDismissPrompt={() => {}}
      {...overrides}
    />,
  );
}

describe('NotificationPanel', () => {
  test('a row shows its title, its kind, its project and its age', () => {
    const out = render();
    expect(out).toContain('>Release notes<');
    expect(out).toContain('>Question<');
    expect(out).toContain('>Website<');
    expect(out).toContain('5m ago');
    expect(out).toContain('>Failure alert<');
  });

  test('a row links to its subject without the read marker: the click marks it read', () => {
    const out = render();
    expect(out).toContain('href="/projects/p1/sessions/ses-b"');
    expect(out).toContain('href="/projects/p1/customize/triggers"');
    expect(out).not.toContain('notification=');
  });

  test('only unread rows carry the unread mark', () => {
    const out = render();
    expect([...out.matchAll(/data-unread=""/g)]).toHaveLength(1);
    expect([...out.matchAll(/>Unread</g)]).toHaveLength(1);
  });

  test('"Mark all as read" shows only while something is unread', () => {
    expect(render()).toContain('Mark all as read');
    expect(render({ unreadCount: 0, rows: [read] })).not.toContain('Mark all as read');
  });

  test('an empty inbox is one line', () => {
    expect(render({ rows: [], unreadCount: 0 })).toContain('Notifications will show up here');
  });

  test('a failed load says so and offers to try again', () => {
    const out = render({ state: 'error', rows: [] });
    expect(out).toContain('Could not load notifications');
    expect(out).toContain('Try again');
  });

  test('while loading no row renders', () => {
    const out = render({ state: 'loading', rows: [] });
    expect(out).not.toContain('href=');
    expect(out).not.toContain('Notifications will show up here');
  });

  test('the footer offers to turn browser notifications on, and can be dismissed', () => {
    expect(render()).not.toContain('Turn on');
    const out = render({ prompt: 'Get notified when Kortix is closed' });
    expect(out).toContain('Get notified when Kortix is closed');
    expect(out).toContain('>Turn on<');
    expect(out).toContain('aria-label="Dismiss"');
  });
});
