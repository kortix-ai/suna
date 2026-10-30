import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useComposerEscapeStop } from './use-composer-escape-stop';

const win = new Window();
Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
Object.defineProperty(globalThis, 'document', { value: win.document, configurable: true });
Object.defineProperty(globalThis, 'KeyboardEvent', { value: win.KeyboardEvent, configurable: true });
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function mount(overrides: Partial<Parameters<typeof useComposerEscapeStop>[0]> = {}) {
  const editor = document.createElement('div');
  document.body.append(editor);
  const onStop = mock(() => undefined);
  const options = { editorElement: editor, enabled: true, hasDraft: false, onStop, ...overrides };
  function Harness() {
    useComposerEscapeStop(options);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  cleanups.push(() => {
    act(() => root.unmount());
    editor.remove();
  });
  const press = (init: { key?: string; isComposing?: boolean; repeat?: boolean } = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
    act(() => editor.dispatchEvent(event));
    return event;
  };
  return { editor, onStop, press };
}

describe('composer Escape stop', () => {
  test('one Escape in an empty composer invokes Stop, even after ProseMirror prevents default', () => {
    const { editor, onStop, press } = mount();
    editor.addEventListener('keydown', (event) => event.preventDefault(), true);
    const pageShortcut = mock(() => undefined);
    window.addEventListener('keydown', pageShortcut);
    try {
      expect(press().defaultPrevented).toBe(true);
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(pageShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', pageShortcut);
    }
  });

  test.each([
    { hasDraft: true },
    { enabled: false },
    { onStop: undefined },
  ])('does not stop when unavailable: %j', (options) => {
    const { onStop, press } = mount(options);
    press();
    expect(onStop).not.toHaveBeenCalled();
  });

  test('does not consume an IME cancellation, repeated Escape, or other key', () => {
    const { onStop, press } = mount();
    press({ isComposing: true });
    press({ repeat: true });
    press({ key: 'Enter' });
    expect(onStop).not.toHaveBeenCalled();
  });

  test('a suggestion menu consumes Escape first, even if it unmounts during keydown', () => {
    const { editor, onStop, press } = mount();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Commands and actions');
    document.body.append(menu);
    editor.addEventListener('keydown', () => menu.remove());
    press();
    expect(onStop).not.toHaveBeenCalled();
    press();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test('unmount removes the shortcut', () => {
    const { onStop, press } = mount();
    cleanups.splice(0).forEach((cleanup) => cleanup());
    press();
    expect(onStop).not.toHaveBeenCalled();
  });
});
