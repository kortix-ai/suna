import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { InboxNotification } from '@kortix/sdk';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * The Inbox page's actions (KRTX-1742), on the real page component in a DOM:
 * a tab filters the rows, "Mark all as read" marks every row, a row click
 * marks that row read, "Notification settings" opens the Settings overlay,
 * and "Turn on" asks for browser permission from the click.
 */

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}
const requestPermission = mock(async () => 'granted');
const notification = { permission: 'default', requestPermission };
originals.set('Notification', Object.getOwnPropertyDescriptor(globalThis, 'Notification'));
Object.defineProperty(globalThis, 'Notification', { configurable: true, value: notification });
Object.defineProperty(browser, 'Notification', { configurable: true, value: notification });

const question: InboxNotification = {
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
const finished: InboxNotification = {
  ...question,
  id: '0192f0c4-0000-7000-8000-000000000002',
  kind: 'turn_done',
  title: 'Weekly digest',
  body: '',
  session_id: 'ses-c',
  url: '/projects/p1/sessions/ses-c',
};

const markRead = mock(async (_ids: string[]) => {});
const markAllRead = mock(async () => {});
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  useNotificationInbox: () => ({
    data: { notifications: [question, finished], unread_count: 2 },
    unreadCount: 2,
    isError: false,
    markRead,
    markAllRead,
    refetch: async () => {},
  }),
}));
// Render the real page without tooltip positioning.
mock.module('../../primitives/hint', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const { NotificationInbox } = await import('./notification-inbox');
const { TestUiHost } = await import('../../test-utils/ui-host');
const { IntlTestProvider } = await import('../../test-utils/intl');
const { defaultUiMessages } = await import('../../i18n');
const { useWebNotificationStore: store } = await import('../stores/web-notification-store');
const { useSettingsPanelStore: settingsStore } = await import('../stores/settings-panel-store');

// The page renders for a signed-in viewer only.
const page = () => (
  <IntlTestProvider locale="en" messages={defaultUiMessages} onError={() => {}}>
    <TestUiHost viewerId="synthetic-user" pathname="/projects/p1/inbox">
      <NotificationInbox />
    </TestUiHost>
  </IntlTestProvider>
);
const initial = store.getInitialState();
const settingsInitial = settingsStore.getInitialState();
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
// A row is an anchor: keep happy-dom from navigating the test window.
const stopNavigation = (event: Event) => event.preventDefault();
document.addEventListener('click', stopNavigation, true);

const button = (text: string) =>
  Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.trim() === text);
const rowTitles = () =>
  Array.from(host.querySelectorAll('a[data-unread], a[href^="/projects/"]')).map((a) => a.querySelector('span span')?.textContent);

afterEach(async () => {
  await act(async () => root.render(null));
  store.setState(initial, true);
  settingsStore.setState(settingsInitial, true);
  requestPermission.mockClear();
  markRead.mockClear();
  markAllRead.mockClear();
});
afterAll(async () => {
  document.removeEventListener('click', stopNavigation, true);
  await act(async () => root.unmount());
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the Needs you tab keeps only what waits on the person; All shows every row again', async () => {
  store.setState({ permission: 'granted', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(page()));
  expect(rowTitles()).toEqual(['Release notes', 'Weekly digest']);
  const needs = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent?.startsWith('Needs you'));
  expect(needs?.textContent).toBe('Needs you1');
  // Radix tabs switch on mousedown with the primary button.
  await act(async () => {
    needs?.dispatchEvent(new browser.MouseEvent('mousedown', { bubbles: true, button: 0 }) as unknown as Event);
  });
  expect(rowTitles()).toEqual(['Release notes']);
  const all = Array.from(host.querySelectorAll('[role="tab"]')).find((tab) => tab.textContent?.startsWith('All'));
  await act(async () => {
    all?.dispatchEvent(new browser.MouseEvent('mousedown', { bubbles: true, button: 0 }) as unknown as Event);
  });
  expect(rowTitles()).toEqual(['Release notes', 'Weekly digest']);
});

test('"Mark all as read" marks every row in one write', async () => {
  store.setState({ permission: 'granted', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(page()));
  await act(async () => button('Mark all as read')?.click());
  expect(markAllRead).toHaveBeenCalledTimes(1);
  expect(markRead).not.toHaveBeenCalled();
});

test('opening a row marks that row read and goes to its subject', async () => {
  store.setState({ permission: 'granted', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(page()));
  const row = host.querySelector('a[href="/projects/p1/sessions/ses-b"]') as HTMLAnchorElement | null;
  expect(row).not.toBeNull();
  await act(async () => row?.click());
  expect(markRead).toHaveBeenCalledTimes(1);
  expect(markRead.mock.calls[0]?.[0]).toEqual([question.id]);
});

test('"Notification settings" opens the Settings overlay on the Notifications pane', async () => {
  store.setState({ permission: 'granted', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(page()));
  await act(async () => button('Notification settings')?.click());
  expect(settingsStore.getState().open).toBe(true);
  expect(settingsStore.getState().tab).toBe('sessions');
});

test('a fresh enabled profile grants browser permission from the page in one click', async () => {
  store.setState({ permission: 'default', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(page()));
  const turnOn = button('Turn on');
  expect(turnOn).toBeDefined();
  await act(async () => turnOn?.click());
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(store.getState().preferences.enabled).toBe(true);
  expect(store.getState().permission).toBe('granted');
});

for (const permission of ['default', 'granted'] as const) {
  test(`a saved opt-out turns on from the page with ${permission} permission`, async () => {
    store.setState({ permission, preferences: { ...initial.preferences, enabled: false } });
    await act(async () => root.render(page()));
    await act(async () => button('Turn on')?.click());
    expect(store.getState().preferences.enabled).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
}

test('granted and denied permissions offer no browser prompt', async () => {
  store.setState({ permission: 'granted', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(page()));
  expect(host.textContent).not.toContain('Turn on');
  store.setState({ permission: 'denied' });
  await act(async () => root.render(page()));
  expect(host.textContent).not.toContain('Turn on');
  expect(requestPermission).not.toHaveBeenCalled();
});
