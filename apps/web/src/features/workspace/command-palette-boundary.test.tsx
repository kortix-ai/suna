import { afterEach, expect, test } from 'bun:test';
import React, { act, lazy, useEffect, useState } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const win = new Window();
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, getComputedStyle: win.getComputedStyle.bind(win) })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && (!(key in globalThis) || key.endsWith('Event'))) {
    Object.defineProperty(globalThis, key, { value: Reflect.get(win, key), configurable: true, writable: true });
  }
}
const { createRoot } = await import('react-dom/client');
const { CommandDialog } = await import('@kortix/ui/command');
const { CommandPaletteBoundary } = await import('./command-palette-boundary');
const { openCommandPalette, consumePendingCommandPalette } = await import('@kortix/ui/internal/layout/open-command-palette');
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  consumePendingCommandPalette();
});

function shortcut(metaKey = false) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: !metaKey, metaKey, bubbles: true }));
}
function dialog() { return document.querySelector('[role="dialog"]'); }
function mountPending() {
  let resolve = () => {};
  let consumed = 0;
  // A controlled lazy child implements the existing palette's mount/keyboard
  // contract without importing its unrelated workspace providers.
  function Loaded() {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      if (consumePendingCommandPalette()) { consumed++; setOpen(true); }
      const down = (event: KeyboardEvent) => {
        if (event.key === 'k' && (event.ctrlKey || event.metaKey)) setOpen(previous => !previous);
      };
      document.addEventListener('keydown', down);
      return () => document.removeEventListener('keydown', down);
    }, []);
    return <CommandDialog open={open} onOpenChange={setOpen}><div>Ready</div></CommandDialog>;
  }
  const Child = lazy(() => new Promise<{ default: typeof Loaded }>(done => { resolve = () => done({ default: Loaded }); }));
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(<><button onClick={openCommandPalette}>Search</button><CommandPaletteBoundary><Child /></CommandPaletteBoundary></>);
  return { resolve: () => resolve(), consumed: () => consumed };
}

test('an early request paints loading and survives lazy handoff exactly once', async () => {
  openCommandPalette();
  let pending: ReturnType<typeof mountPending> | undefined;
  await act(async () => { pending = mountPending(); });
  expect(dialog()).not.toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading...');
  expect(dialog()?.className).toContain('top-[17vh]');
  await act(async () => pending?.resolve());
  expect(dialog()?.textContent).toContain('Ready');
  expect(pending?.consumed()).toBe(1);
  expect(consumePendingCommandPalette()).toBe(false);
  await act(async () => shortcut());
  expect(dialog()).toBeNull();
  await act(async () => shortcut(true));
  expect(dialog()).not.toBeNull();
});

test('click and both shortcuts respond immediately; dismissal never reopens on resolution', async () => {
  let pending: ReturnType<typeof mountPending> | undefined;
  await act(async () => { pending = mountPending(); });
  expect(dialog()).toBeNull();
  await act(async () => document.querySelector('button')?.click());
  expect(dialog()).not.toBeNull();
  await act(async () => shortcut());
  expect(dialog()).toBeNull();
  await act(async () => shortcut(true));
  expect(dialog()).not.toBeNull();
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(dialog()).toBeNull();
  await act(async () => pending?.resolve());
  expect(dialog()).toBeNull();
  expect(pending?.consumed()).toBe(0);
  expect(consumePendingCommandPalette()).toBe(false);
});
