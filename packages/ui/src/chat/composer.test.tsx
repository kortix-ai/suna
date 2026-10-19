/**
 * A refused slash command is never silent: the typed line comes back into the
 * input, and the error shows as an alert (or goes to `onError`). Rendered on
 * happy-dom (the model-picker.test.tsx setup).
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

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
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

// react-dom reads `window` when it loads (its `input` event support check), so
// it loads after the DOM globals exist.
const { createRoot } = await import('react-dom/client');
const { Composer } = await import('./composer');

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container as never);
  roots.push(root);
  act(() => root.render(node));
  return document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement;
}

function type(input: HTMLTextAreaElement, text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, text);
    input.dispatchEvent(new (globals.Event as typeof Event)('input', { bubbles: true }));
  });
}

async function pressEnter(input: HTMLTextAreaElement) {
  await act(async () => {
    input.dispatchEvent(new (globals.KeyboardEvent as typeof KeyboardEvent)('keydown', { key: 'Enter', bubbles: true }));
  });
}

const commands = [{ name: 'greet', description: 'Say hello' }];
const refuse = () => Promise.reject(new Error('SESSION_MODEL_CATALOG_STALE'));

test('a rejected command keeps the typed line and shows the error as an alert', async () => {
  const runs: [string, string][] = [];
  const input = mount(
    <Composer
      onSend={() => {}}
      onStop={() => {}}
      busy={false}
      commands={commands}
      onCommand={(name, args) => {
        runs.push([name, args]);
        return refuse();
      }}
    />,
  );
  type(input, '/greet World');
  await pressEnter(input);

  expect(runs).toEqual([['greet', 'World']]);
  expect(input.value).toBe('/greet World');
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('The command did not run');
  expect(alert?.textContent).toContain('SESSION_MODEL_CATALOG_STALE');
});

test('with onError the rejection goes to the host, not inline', async () => {
  const reported: string[] = [];
  const input = mount(
    <Composer
      onSend={() => {}}
      onStop={() => {}}
      busy={false}
      commands={commands}
      onCommand={refuse}
      onError={(message) => reported.push(message)}
    />,
  );
  type(input, '/greet World');
  await pressEnter(input);

  expect(reported).toEqual(['SESSION_MODEL_CATALOG_STALE']);
  expect(input.value).toBe('/greet World');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

test('a command that succeeds clears the input and shows no alert', async () => {
  const input = mount(
    <Composer
      onSend={() => {}}
      onStop={() => {}}
      busy={false}
      commands={commands}
      onCommand={() => Promise.resolve()}
    />,
  );
  type(input, '/greet World');
  await pressEnter(input);

  expect(input.value).toBe('');
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
