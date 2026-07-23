import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
}
// `openPortInSessionPanel` parks the preview tab on the session's own route,
// which it reads off `window.location`.
//
// `globalThis` is process-wide even under `bun test --isolate` (that isolates
// the module registry, not the global object), so a `window` left standing here
// leaks into every file scheduled after this one — and the SSR-snapshot tests
// in this repo branch on `typeof window === 'undefined'`. Hence the afterAll:
// this shim must not outlive the file that needed it.
const installedWindow = typeof (globalThis as any).window === 'undefined';
if (installedWindow) {
  (globalThis as any).window = {
    location: { pathname: '/projects/p1/sessions/s1', origin: 'http://localhost:3000' },
  };
}
afterAll(() => {
  if (installedWindow) delete (globalThis as any).window;
});

import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { sessionPreviewTabId, useSessionBrowserStore } from '@/stores/session-browser-store';
import { useTabStore } from '@/stores/tab-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { openPortInSessionPanel } from './open-port-in-panel';

const TARGET = {
  port: 3000,
  path: '/docs',
  proxyUrl: 'https://proxy.example/3000/docs',
  internalUrl: 'http://localhost:3000/docs',
};

function setPanelMode(panelMode: 'easy' | 'advanced') {
  useUserPreferencesStore.setState({
    preferences: { ...useUserPreferencesStore.getState().preferences, panelMode },
  });
}

describe('openPortInSessionPanel', () => {
  beforeEach(() => {
    useSessionBrowserStore.setState({
      activeSessionId: 'chat-1',
      appOpenBySession: {},
      viewBySession: {},
    });
    useKortixComputerStore.setState({ isSidePanelOpen: false });
    setPanelMode('easy');
  });

  test('off a session page it declines, so the caller can fall back to a tab', () => {
    useSessionBrowserStore.setState({ activeSessionId: null });

    expect(openPortInSessionPanel(TARGET)).toBe(false);
    expect(useSessionBrowserStore.getState().appOpenBySession).toEqual({});
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(false);
  });

  test('Easy mode: requests the port and reveals the panel', () => {
    expect(openPortInSessionPanel(TARGET)).toBe(true);

    const request = useSessionBrowserStore.getState().appOpenBySession['chat-1'];
    // The INTERNAL url, never the proxied one: `AppPreview` proxies whatever
    // it is handed, so a pre-proxied url would be proxied twice.
    expect(request?.url).toBe('http://localhost:3000/docs');
    expect(request?.name).toBe('localhost:3000');
    expect(useKortixComputerStore.getState().isSidePanelOpen).toBe(true);
  });

  test('Easy mode leaves `viewBySession` alone', () => {
    openPortInSessionPanel(TARGET);

    // Writing a view the user cannot see and never chose would surface as an
    // unexplained jump to the browser tab on their next mode switch.
    expect(useSessionBrowserStore.getState().viewBySession['chat-1']).toBeUndefined();
    expect(useTabStore.getState().tabs[sessionPreviewTabId('chat-1')]).toBeUndefined();
  });

  test('Advanced mode also drives BrowserPanel through the preview tab', () => {
    setPanelMode('advanced');

    expect(openPortInSessionPanel(TARGET)).toBe(true);

    expect(useSessionBrowserStore.getState().viewBySession['chat-1']).toBe('browser');
    const tab = useTabStore.getState().tabs[sessionPreviewTabId('chat-1')];
    // BrowserPanel iframes `metadata.url`, so THAT one is the proxied url.
    expect(tab?.metadata?.url).toBe('https://proxy.example/3000/docs');
    expect(tab?.metadata?.port).toBe(3000);
    expect(tab?.metadata?.originalUrl).toBe('http://localhost:3000/docs');
    // Panel content, not a destination — it must not move the address bar off
    // the session.
    expect(tab?.href).toBe('/projects/p1/sessions/s1');
  });

  test('the header label defaults to the port and is overridable', () => {
    openPortInSessionPanel({ ...TARGET, title: 'Docs site' });
    expect(useSessionBrowserStore.getState().appOpenBySession['chat-1']?.name).toBe('Docs site');
  });
});
