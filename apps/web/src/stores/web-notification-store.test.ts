import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const win = new Window({ url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
const { useWebNotificationStore: store } = await import('./web-notification-store');
const initial = store.getInitialState();

afterEach(() => {
  win.localStorage.clear();
  store.setState(initial, true);
});

test('a fresh browser enables session notifications without requesting OS permission', () => {
  expect(initial.preferences.enabled).toBe(true);
  expect(initial.preferences.onCompletion).toBe(true);
  expect(initial.permission).toBe('default');
});

test('an explicit opt-out survives rehydration', async () => {
  store.getState().setPreference('enabled', false);
  store.setState(initial, true);
  // Restore the saved opt-out, as a new page load would.
  win.localStorage.setItem('kortix-web-notifications', JSON.stringify({
    state: { preferences: { ...initial.preferences, enabled: false }, promptDismissed: false },
    version: 0,
  }));
  await store.persist.rehydrate();
  expect(store.getState().preferences.enabled).toBe(false);
  expect(store.getState().preferences.onCompletion).toBe(true);
});
