import { afterEach, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Container, type Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
// Bun has its own event classes. Radix's focus and dismiss layers create
// events by bare global name, and happy-dom dispatches only its own (the
// change-request-detail-dialog-controls.test.tsx setup).
for (const key of [
  'Event',
  'CustomEvent',
  'FocusEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
]) {
  globals[key] = Reflect.get(win, key);
}

mock.module('../../i18n', () => ({ useTranslations: () => (key: string) => key }));
mock.module('../../internal/components/hover-prefetch-link', () => ({
  HoverPrefetchLink: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a {...props}>{children}</a>
  ),
}));
mock.module('../../primitives/faded-scroll-area', () => ({
  FadedScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module('../actions/project-session-list-helpers', () => ({
  getSessionDisplayTitle: (session: { name: string }) => session.name,
  shortRelative: (value: string) => value,
}));
mock.module('../agents/agent-model', () => ({ subagentTitle: (value: string) => value }));
Object.assign(win, {
  setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

const { SubagentHoverCard } = await import('./subagent-hover-card');
let root: Root;
afterEach(() => {
  act(() => root?.unmount());
  jest.useRealTimers();
  win.document.body.innerHTML = '';
});
async function mount() {
  jest.useFakeTimers();
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  root = createRoot(host as unknown as Container);
  await act(async () =>
    root.render(
      <>
        <SubagentHoverCard
          projectId="project"
          projectSessionId="parent"
          subsessions={[{ id: 'child', title: 'Child', parent_id: 'root', project_id: 'project', created_at: null, updated_at: null, archived_at: null }]}
        >
          <button>Parent</button>
        </SubagentHoverCard>
        <textarea aria-label="Composer" />
      </>,
    ),
  );
  const title = win.document.querySelector('button')!;
  await act(async () => {
    title.focus();
    title.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  expect(win.document.activeElement?.textContent).toBe('Child');
  return title;
}
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}
test('Escape returns to the title and leaves both cards closed after the hover delay', async () => {
  const title = await mount();
  await act(async () => {
    win.document.activeElement!.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  await advance(0);
  expect(win.document.activeElement === title).toBe(true);
  await advance(700);
  expect(!!win.document.querySelector('[data-slot="popover-content"]')).toBe(false);
  expect(!!win.document.querySelector('[data-slot="hover-card-content"]')).toBe(false);
});
test('clicking the composer preserves its focus after dismissing the keyboard list', async () => {
  await mount();
  const composer = win.document.querySelector('textarea')!;
  await advance(0);
  await act(async () => {
    composer.dispatchEvent(
      new win.PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }),
    );
    composer.focus();
    composer.dispatchEvent(
      new win.PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse' }),
    );
    composer.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
  await advance(0);
  await advance(700);
  expect(win.document.activeElement === composer).toBe(true);
  expect(!!win.document.querySelector('[data-slot="popover-content"]')).toBe(false);
  expect(!!win.document.querySelector('[data-slot="hover-card-content"]')).toBe(false);
});
