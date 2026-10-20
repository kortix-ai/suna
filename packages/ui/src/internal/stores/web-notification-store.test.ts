import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: browser });
import { useWebNotificationStore } from './web-notification-store';

const initial = useWebNotificationStore.getInitialState();

afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

afterEach(() => {
  browser.localStorage.removeItem('kortix-web-notifications');
  useWebNotificationStore.setState(initial, true);
});

describe('session notification preferences', () => {
  test('a fresh profile enables completion notifications without granting browser permission', () => {
    expect(initial.preferences.enabled).toBe(true);
    expect(initial.preferences.onCompletion).toBe(true);
    expect(initial.permission).toBe('default');
  });

  test('an explicit opt-out survives hydration', async () => {
    useWebNotificationStore.getState().setPreference('enabled', false);
    const saved = browser.localStorage.getItem('kortix-web-notifications');
    expect(saved).toContain('"enabled":false');
    useWebNotificationStore.setState(initial, true);
    browser.localStorage.setItem('kortix-web-notifications', saved ?? '');
    await useWebNotificationStore.persist.rehydrate();
    expect(useWebNotificationStore.getState().preferences.enabled).toBe(false);
  });

  test('the enabled default can be turned off without browser permission', async () => {
    await useWebNotificationStore.getState().toggleEnabled();
    expect(useWebNotificationStore.getState().preferences.enabled).toBe(false);
  });
});
