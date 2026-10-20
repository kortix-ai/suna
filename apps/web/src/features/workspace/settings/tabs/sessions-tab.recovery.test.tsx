import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

const win = new Window({ url: 'http://localhost/settings/sessions' });
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  navigator: { value: win.navigator, configurable: true },
  HTMLFormElement: { value: win.HTMLFormElement, configurable: true },
  HTMLElement: { value: win.HTMLElement, configurable: true },
  Node: { value: win.Node, configurable: true },
  SVGElement: { value: win.SVGElement, configurable: true },
  Element: { value: win.Element, configurable: true },
  getComputedStyle: { value: win.getComputedStyle.bind(win), configurable: true },
  ResizeObserver: { value: win.ResizeObserver, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
  Notification: { value: { permission: 'denied' }, configurable: true },
});
Object.defineProperty(win, 'Notification', { value: { permission: 'denied' }, configurable: true });
const played: string[] = [];
class TestAudio {
  preload = '';
  volume = 1;
  currentTime = 0;
  constructor(readonly src: string) {}
  play() {
    played.push(this.src);
    return Promise.resolve();
  }
}
Object.defineProperty(globalThis, 'Audio', { value: TestAudio, configurable: true });
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));

const { SessionsTab } = await import('./sessions-tab');
const { useSoundStore } = await import('@/stores/sound-store');
const { useWebNotificationStore } = await import('@/stores/web-notification-store');
const { sendWebNotification } = await import('@/lib/web-notifications');
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
afterEach(async () => {
  await act(async () => root.render(null));
  played.length = 0;
});

for (const pack of ['off', 'kortix'] as const) {
  test(`blocked customer enables effective completion sounds from ${pack}`, async () => {
    useSoundStore.setState({
      preferences: {
        pack,
        volume: pack === 'off' ? 0 : 0.7,
        events: { completion: false, send: false },
      },
    });
    useWebNotificationStore.setState({
      permission: 'denied',
      preferences: {
        ...useWebNotificationStore.getState().preferences,
        enabled: false,
        playSound: false,
      },
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <SessionsTab />
        </QueryClientProvider>,
      ),
    );
    const button = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'Enable completion sound',
    );
    expect(button).toBeDefined();
    await act(async () => button?.click());
    expect(useSoundStore.getState().preferences).toEqual({
      pack: pack === 'off' ? 'opencode' : 'kortix',
      volume: pack === 'off' ? 0.5 : 0.7,
      events: { completion: true, send: false },
    });
    expect(useWebNotificationStore.getState().preferences.playSound).toBe(true);
    expect(useWebNotificationStore.getState().preferences.enabled).toBe(false);
    expect(played).toHaveLength(1);
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    sendWebNotification({ type: 'completion', title: 'Finished', body: 'Task finished' });
    expect(played).toHaveLength(2);
    expect(played[1]).toBe(`/sounds/${pack === 'off' ? 'opencode' : pack}/completion.mp3`);
  });
}
