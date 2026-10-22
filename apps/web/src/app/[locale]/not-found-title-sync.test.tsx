import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Container } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}

import { NotFoundTitleSync } from './not-found-title-sync';

/**
 * The 404 boundary renders this sync as a client-side guard for the tab
 * title: a client-side navigation that lands on the boundary with an aborted
 * layout (e.g. the /blog surface) never mounts the flight's head, so no
 * metadata-owned <title> arrives and the tab keeps the previous page's
 * title. The sync writes the title the boundary's metadata produces — and
 * stays quiet whenever that title (or a composition of it) is already in
 * place, so it never fights the metadata owner
 * (cf. packages/ui/src/session/status/session-tab-title-sync.tsx).
 */
describe('NotFoundTitleSync', () => {
  const HEADING = '404 Page not found';

  function mountWithTitle(title: string): () => void {
    document.title = title;
    // happy-dom's document produces happy-dom nodes, which are structurally
    // distinct from the DOM-lib types react-dom's `Container` accepts — the
    // same bridge the repo's other happy-dom harnesses use.
    const host = win.document.createElement('div');
    win.document.body.appendChild(host);
    const root = createRoot(host as unknown as Container);
    act(() => {
      root.render(<NotFoundTitleSync heading={HEADING} />);
    });
    return () => {
      act(() => {
        root.unmount();
      });
      host.parentNode?.removeChild(host);
    };
  }

  test('a navigation that landed on the boundary with a stale title gets the 404 title', () => {
    const unmount = mountWithTitle('Pricing | Kortix');
    try {
      expect(document.title).toBe('404 Page not found | Kortix');
    } finally {
      unmount();
    }
  });

  test('it stays quiet when the metadata-owned 404 title is already in place', () => {
    const unmount = mountWithTitle('404 Page not found | Kortix');
    try {
      expect(document.title).toBe('404 Page not found | Kortix');
    } finally {
      unmount();
    }
  });

  test('the hard load already carries the boundary title verbatim, so it is left alone', () => {
    const unmount = mountWithTitle(HEADING);
    try {
      expect(document.title).toBe(HEADING);
    } finally {
      unmount();
    }
  });

  test('it re-asserts the 404 title when the metadata commit clobbers it while mounted', async () => {
    const unmount = mountWithTitle('Pricing | Kortix');
    try {
      expect(document.title).toBe('404 Page not found | Kortix');
      // The tree's own metadata commit re-asserts the previous page's title
      // after client effects run (session-tab-title-sync measured the race).
      document.title = 'Kortix – The open-source AI Operating System';
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(document.title).toBe('404 Page not found | Kortix');
    } finally {
      unmount();
    }
  });

  test('it stops guarding once unmounted so the next page owns the tab again', async () => {
    const unmount = mountWithTitle('Pricing | Kortix');
    unmount();
    document.title = 'Docs | Kortix';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.title).toBe('Docs | Kortix');
  });
});
