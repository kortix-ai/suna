/**
 * ModelPicker picks from the keyboard: in the search field, ArrowDown moves the
 * highlight and Enter selects it, as the composer's command menu does. Rendered
 * open on happy-dom (the floating-panel-motion.test.tsx setup).
 */
import { afterEach, expect, test } from 'bun:test';
import type { FlatModel, ModelKey } from '@kortix/sdk/react';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

const { ModelPicker } = await import('./model-picker');

const models = [
  { providerID: 'kortix', providerName: 'Kortix', modelID: 'glm', modelName: 'GLM 5' },
  { providerID: 'kortix', providerName: 'Kortix', modelID: 'kimi-k3', modelName: 'Kimi K3' },
  { providerID: 'kortix', providerName: 'Kortix', modelID: 'kimi-k3-mini', modelName: 'Kimi K3 Mini' },
] as unknown as FlatModel[];

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
});

function Harness({ onPick }: { onPick: (v: ModelKey | null) => void }) {
  const [value, setValue] = React.useState<ModelKey | null>(null);
  return (
    <ModelPicker
      models={models}
      value={value}
      onChange={(v) => {
        setValue(v);
        onPick(v);
      }}
      providerLabel={() => 'Lumen'}
    />
  );
}

function key(target: Element, k: string) {
  act(() => {
    target.dispatchEvent(new (globals.KeyboardEvent as typeof KeyboardEvent)('keydown', { key: k, bubbles: true }));
  });
}

test('ArrowDown then Enter in the search field picks the highlighted model and closes the list', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container as never);
  roots.push(root);
  const picks: (ModelKey | null)[] = [];
  act(() => root.render(<Harness onPick={(v) => picks.push(v)} />));

  const trigger = document.querySelector('[aria-label="Model"]') as HTMLElement;
  act(() => {
    trigger.dispatchEvent(new (globals.PointerEvent as typeof PointerEvent)('pointerdown', { bubbles: true, button: 0 }));
    trigger.click();
  });
  const search = document.querySelector('input[aria-label="Search models…"]') as HTMLInputElement;
  expect(search).toBeTruthy();
  expect(document.body.innerHTML).toContain('Lumen');
  expect(document.body.innerHTML).not.toContain('>Kortix<');

  // Move down twice (to the last row), once more (clamped), then pick.
  const options = () => [...document.querySelectorAll('[role="option"]')];
  expect(options().length).toBe(3);
  expect(options()[0]!.hasAttribute('data-highlighted')).toBe(true);
  key(search, 'ArrowDown');
  key(search, 'ArrowDown');
  expect(options()[2]!.hasAttribute('data-highlighted')).toBe(true);
  expect(search.getAttribute('aria-activedescendant')).toBe(options()[2]!.id);
  key(search, 'ArrowDown'); // clamps at the last row
  expect(options()[2]!.hasAttribute('data-highlighted')).toBe(true);
  key(search, 'ArrowUp');
  key(search, 'ArrowDown');
  key(search, 'Enter');

  expect(picks).toEqual([{ providerID: 'kortix', modelID: 'kimi-k3-mini' }]);
  expect(document.querySelector('input[aria-label="Search models…"]')).toBeNull();
  expect(trigger.textContent).toContain('Kimi K3 Mini');
});
