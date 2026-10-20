import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
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

mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'synthetic-user' } }) }));
mock.module('./use-notification-center', () => ({ useNotificationCenter: () => true, cachedNotificationCenter: () => true, cachedNotificationCenterAnswer: () => true }));
mock.module('@kortix/sdk/react', () => ({
  useNotificationInbox: () => ({ data: { notifications: [] }, unreadCount: 0 }),
}));
// Render the real bell content without its portal or tooltip positioning.
mock.module('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module('@/components/ui/hint', () => ({ default: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const { NotificationBell } = await import('./notification-bell');
const { useWebNotificationStore: store } = await import('@/stores/web-notification-store');
const initial = store.getInitialState();
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);

afterEach(async () => {
  await act(async () => root.render(null));
  store.setState(initial, true);
  requestPermission.mockClear();
});
afterAll(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('fresh enabled profile can grant browser permission from the bell in one click', async () => {
  store.setState({ permission: 'default', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(<NotificationBell />));
  const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Turn on');
  expect(button).toBeDefined();
  await act(async () => button?.click());
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(store.getState().preferences.enabled).toBe(true);
  expect(store.getState().permission).toBe('granted');
});

test('granted enabled profiles do not offer permission again', async () => {
  store.setState({ permission: 'granted', preferences: { ...initial.preferences, enabled: true } });
  await act(async () => root.render(<NotificationBell />));
  expect(host.textContent).not.toContain('Turn on');
});

for (const permission of ['default', 'granted'] as const) {
  test(`saved opt-out can be enabled from the bell with ${permission} permission`, async () => {
    store.setState({ permission, preferences: { ...initial.preferences, enabled: false } });
    await act(async () => root.render(<NotificationBell />));
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent === 'Turn on');
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(store.getState().preferences.enabled).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });
}

test('denied permission does not offer a browser prompt', async () => {
  store.setState({ permission: 'denied' });
  await act(async () => root.render(<NotificationBell />));
  expect(host.textContent).not.toContain('Turn on');
  expect(requestPermission).not.toHaveBeenCalled();
});
