/**
 * A Kortix App link clicked in a session opens in that session's browser panel,
 * beside the chat, instead of a new browser tab (KRTX-2441). Off a session page
 * the link keeps its native new-tab behavior.
 *
 * Drives a real click through the mounted interceptor on `happy-dom`, the
 * pattern of `features/review-center/review-center-verdicts.test.tsx`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ url: 'http://localhost:3000/projects/p1/sessions/s1', width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
// Persisted stores read the bare `localStorage` binding at import.
globals.localStorage = win.localStorage;
globals.sessionStorage = win.sessionStorage;
// Other files in the same `bun test` process see these globals too; a
// `window` without `customElements` breaks their web-component imports.
globals.customElements = win.customElements;
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}

const { LocalhostLinkInterceptor } = await import('./localhost-link-interceptor');
const { sessionPreviewTabId, useSessionBrowserStore } = await import('@/stores/session-browser-store');
const { useTabStore } = await import('@/stores/tab-store');

const PANEL_SESSION = 'chat-session-1';
const APP_URL = 'https://dev-crm-0123456789abcdef.apps.kortix.com/deals/42';

let root: Root;
let host: HTMLElement;

beforeEach(async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<LocalhostLinkInterceptor />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useSessionBrowserStore.getState().setActiveSessionId(null);
  useTabStore.getState().closeTab(sessionPreviewTabId(PANEL_SESSION));
});

function click(href: string): MouseEvent {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  host.appendChild(anchor);
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  anchor.dispatchEvent(event as unknown as Event);
  anchor.remove();
  return event as unknown as MouseEvent;
}

describe('LocalhostLinkInterceptor — Kortix App links', () => {
  test('on a session page, an App link opens in the session browser on its own origin', () => {
    useSessionBrowserStore.getState().setActiveSessionId(PANEL_SESSION);

    const event = click(APP_URL);

    expect(event.defaultPrevented).toBe(true);
    const tab = useTabStore.getState().tabs[sessionPreviewTabId(PANEL_SESSION)];
    expect(tab?.type).toBe('preview');
    // No proxy rewrite: the App's own origin keeps its access cookie.
    expect(tab?.metadata?.url).toBe(APP_URL);
    expect(tab?.metadata?.port).toBe(0);
  });

  test('a local App host (*.apps.localhost) is routed the same way', () => {
    useSessionBrowserStore.getState().setActiveSessionId(PANEL_SESSION);
    const local = 'http://0123456789abcdef.apps.localhost:14008/';

    expect(click(local).defaultPrevented).toBe(true);
    expect(useTabStore.getState().tabs[sessionPreviewTabId(PANEL_SESSION)]?.metadata?.url).toBe(local);
  });

  test('off a session page, an App link keeps its native new-tab behavior', () => {
    expect(click(APP_URL).defaultPrevented).toBe(false);
  });

  test('an ordinary external link is not taken over', () => {
    useSessionBrowserStore.getState().setActiveSessionId(PANEL_SESSION);
    expect(click('https://example.com/docs').defaultPrevented).toBe(false);
  });
});
