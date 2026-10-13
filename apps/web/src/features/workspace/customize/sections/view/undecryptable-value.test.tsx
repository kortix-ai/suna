// KRTX-1719: a stored value Kortix can no longer decrypt (the encryption key
// changed, or the row is damaged) used to read "Set" in the secrets list, and
// a session start failed with no name. The row now shows an "Undecryptable"
// badge, and for someone who manages the project a "Re-enter value" button
// that opens the row's existing edit dialog. These tests mount the real
// component in happy-dom and click the real button.
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}

import { UndecryptableValue } from './undecryptable-value';

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('UndecryptableValue', () => {
  test('a manager sees the badge and a Re-enter value button that opens the edit flow', () => {
    let opened = 0;
    const el = mount(<UndecryptableValue onReenter={() => opened++} />);

    expect(el.textContent).toContain('Undecryptable');
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Re-enter value');
    expect(button).toBeDefined();

    act(() => {
      button!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }) as unknown as Event);
    });
    expect(opened).toBe(1);
  });

  test('a viewer who cannot write the value sees the badge and no action', () => {
    const el = mount(<UndecryptableValue />);

    expect(el.textContent).toContain('Undecryptable');
    expect(el.querySelectorAll('button')).toHaveLength(0);
  });

  test('the badge is keyboard-reachable and carries no value', () => {
    const el = mount(<UndecryptableValue onReenter={() => {}} />);
    const badge = el.querySelector('[data-slot="badge"]');

    expect(badge?.getAttribute('tabindex')).toBe('0');
    expect(badge?.querySelector('svg')).not.toBeNull();
  });
});
