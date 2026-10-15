/**
 * The embedded chip's marker tracks the VISIBLE route — the regression for the
 * bug the round-3 review caught (KRTX-2145).
 *
 * Next's client cache keeps recently visited session views mounted inside React
 * `<Activity mode="hidden">` (see `session-route-cache.tsx`). A hidden tree
 * stays in the DOM, so the declarative `data-kx-account-owner` on the chip kept
 * matching the shell's `[data-kx-titlebar-owner]:has([data-kx-account-owner])
 * .kx-app-account-corner { display: none }` rule and the corner stayed hidden
 * on the view the user was actually looking at. The marker now lives in an
 * effect (present while the owning view is visible, cleared while hidden).
 *
 * This test drives the real mechanism — React's own `Activity`, a real client
 * mount under happy-dom, real effect lifecycles — instead of asserting on
 * source text or static markup, which cannot observe effect cleanup.
 * Delete the marker's effect in `account-menu-button.tsx` and the hidden-mode
 * assertion fails: the retained node would still carry the declarative
 * attribute and the corner would stay suppressed.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { Activity, type ReactNode, act, createElement } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { AccountMenuButton } from './account-menu-button';

// Mocks are process-global in bun, so this file mocks ONLY what the chip's
// own tree touches — the same two stand-ins the other chip tests use (auth
// provider, next/link). A wider mock set here shadows the real `ui/sidebar`
// module for every file that loads after this one and breaks their imports
// (missing named exports at link time).
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { email: 'dev@example.test', user_metadata: { name: 'Grace Hopper' } },
    session: null,
    isLoading: false,
  }),
}));
mock.module('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    replace: _replace,
    scroll: _scroll,
    shallow: _shallow,
    locale: _locale,
    legacyBehavior: _legacyBehavior,
    passHref: _passHref,
    ...rest
  }: { href: string; children?: ReactNode; [key: string]: unknown }) =>
    createElement('a', { ...rest, href }, children),
}));

const globalKeys = ['window', 'document', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'];
const previousGlobals = new Map(
  globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
let root: Root | undefined;
let container: HTMLDivElement;

beforeAll(() => {
  const win = new Window({ url: 'http://localhost/' });
  for (const [key, value] of Object.entries({
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterAll(async () => {
  try {
    await act(async () => root?.unmount());
    container.remove();
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

/**
 * The shape under test: the shell's owner row wraps the session header's
 * embedded chip inside an Activity the route cache flips to hidden, while the
 * project shell's floating corner chip sits outside it (never hidden, never
 * stamped — proven separately in `account-top-bar.test.tsx`).
 */
function CacheShape({ mode }: { mode: 'visible' | 'hidden' }) {
  return createElement(
    'div',
    { 'data-kx-titlebar-owner': '' },
    <Activity mode={mode}>
      <AccountMenuButton embedded />
    </Activity>,
    createElement('div', { className: 'kx-app-account-corner' }, createElement(AccountMenuButton)),
  );
}

describe('the embedded chip marker tracks the visible route', () => {
  test('hidden Activity retains the real chip but releases ownership until shown again', async () => {
    const mounted = root;
    if (!mounted) throw new Error('React root was not initialized');
    await act(async () => mounted.render(createElement(CacheShape, { mode: 'visible' })));
    const markers = () => container.querySelectorAll('[data-kx-account-owner]').length;
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Logged in as"]');
    if (!button) throw new Error('Embedded account chip did not render');
    expect(markers()).toBe(1);
    expect(button.closest('[data-kx-titlebar-owner]')).not.toBeNull();

    await act(async () => mounted.render(createElement(CacheShape, { mode: 'hidden' })));
    expect(button.isConnected).toBe(true);
    expect(markers()).toBe(0);

    await act(async () => mounted.render(createElement(CacheShape, { mode: 'visible' })));
    expect(markers()).toBe(1);
    expect(button.isConnected).toBe(true);
    expect(container.querySelector('button[aria-label^="Logged in as"]')).toBe(button);
  });
});
