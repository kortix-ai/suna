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
 * source text or static markup, which cannot see either effects or display.
 * Delete the marker's effect in `account-menu-button.tsx` and the hidden-mode
 * assertion fails: the retained node would still carry the declarative
 * attribute and the corner would stay suppressed.
 */

import { Activity, act } from 'react';
import { createElement, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

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

let root: Root | null = null;

// The DOM environment exists only while this file runs: later files in the
// same bun process must keep seeing the bare runtime (`typeof window ===
// 'undefined'`), or their module-level code takes browser branches (files-store
// reads `localStorage` at import time) that the bare runtime does not serve.
let prev: { window?: unknown; document?: unknown; navigator?: unknown; localStorage?: unknown } = {};

beforeAll(() => {
  const { Window } = require('happy-dom') as typeof import('happy-dom');
  const win = new Window({ url: 'http://localhost/' });
  prev = {
    window: (globalThis as { window?: unknown }).window,
    document: (globalThis as { document?: unknown }).document,
    navigator: (globalThis as { navigator?: unknown }).navigator,
    localStorage: (globalThis as { localStorage?: unknown }).localStorage,
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.document = win.document as unknown as Document;
  globalThis.navigator = win.navigator as unknown as Navigator;
  globalThis.localStorage = win.localStorage as unknown as Storage;
  // React's act() needs an explicit opt-in outside a DOM-testing framework.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(async () => {
  const mounted = root;
  if (mounted) {
    act(() => {
      mounted.unmount();
    });
    root = null;
  }
  // Let React's scheduler drain the work it posted during the test before the
  // DOM environment goes away: a late scheduler tick reads `window.event`, and
  // throwing after the globals are restored would surface as an unhandled
  // error attributed to whichever file runs next.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const g = globalThis as Record<string, unknown>;
  for (const key of ['window', 'document', 'navigator', 'localStorage'] as const) {
    if (prev[key] === undefined) delete g[key];
    else g[key] = prev[key];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
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
    createElement(Activity, { mode, children: createElement(AccountMenuButton, { embedded: true }) }),
    createElement('div', { className: 'kx-app-account-corner' }, createElement(AccountMenuButton)),
  );
}

// The route cache's handle: the harness captures its mode setter here on first
// render so the test can flip the Activity like a navigation would.
const cache = { setMode: undefined as undefined | ((mode: 'visible' | 'hidden') => void) };

function Harness() {
  const [mode, setMode] = useState<'visible' | 'hidden'>('visible');
  cache.setMode = setMode;
  return createElement(CacheShape, { mode });
}

describe('the embedded chip marker tracks the visible route', () => {
  test('hidden Activity trees lose the marker; showing again restores it', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => {
      mounted.render(createElement(Harness));
    });

    const ownerMarkers = () => document.querySelectorAll('[data-kx-account-owner]').length;
    const embeddedButton = () =>
      container.querySelector('button[aria-label^="Logged in as"]') as HTMLButtonElement | null;

    // Visible route: the embedded chip owns the marker, the corner does not.
    expect(ownerMarkers()).toBe(1);
    const button = embeddedButton();
    expect(button).toBeTruthy();
    expect(button?.closest('[data-kx-titlebar-owner]')).toBeTruthy();

    // The route cache hides the view: the tree stays mounted (Next keeps it
    // for instant back-navigation) and its effects unmount — so the marker
    // must leave the document even though the node stays.
    act(() => {
      cache.setMode!('hidden');
    });
    expect(button?.isConnected).toBe(true);
    expect(ownerMarkers()).toBe(0);

    // Back to the view: the effect remounts, the marker returns, and the
    // shell's :has() rule lets the corner step aside again.
    act(() => {
      cache.setMode!('visible');
    });
    expect(ownerMarkers()).toBe(1);
    expect(embeddedButton()?.isConnected).toBe(true);
  });
});
