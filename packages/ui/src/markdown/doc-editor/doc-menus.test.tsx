import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Document', 'MutationObserver', 'DOMParser', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'Range', 'DOMRect', 'NodeFilter', 'ShadowRoot', 'getComputedStyle'] as const) {
  const value = key === 'window' ? browser : key === 'document' ? browser.document : key === 'getComputedStyle' ? browser.getComputedStyle.bind(browser) : browser[key];
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });

const { Editor } = await import('@tiptap/react');
const { default: StarterKit } = await import('@tiptap/starter-kit');
const { DocMenus, isCommentShortcut } = await import('./doc-menus');

type Shortcut = Parameters<typeof isCommentShortcut>[0];
const key = (over: Partial<Shortcut>): Shortcut => ({
  key: 'm', code: 'KeyM', metaKey: false, ctrlKey: false, altKey: true, shiftKey: false, repeat: false, ...over,
});

describe('the comment shortcut', () => {
  test('is ⌘⌥M on a Mac and Ctrl+Alt+M elsewhere, by physical key', () => {
    expect(isCommentShortcut(key({ metaKey: true, key: 'µ' }), true)).toBe(true);
    expect(isCommentShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isCommentShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isCommentShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  test('refuses Shift, a held key, a missing Alt, an extra modifier and another key', () => {
    expect(isCommentShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isCommentShortcut(key({ metaKey: true, repeat: true }), true)).toBe(false);
    expect(isCommentShortcut(key({ metaKey: true, altKey: false }), true)).toBe(false);
    expect(isCommentShortcut(key({ metaKey: true, ctrlKey: true }), true)).toBe(false);
    expect(isCommentShortcut(key({ metaKey: true, code: 'KeyN', key: 'n' }), true)).toBe(false);
    expect(isCommentShortcut(key({ ctrlKey: true, code: 'KeyN', key: 'n' }), false)).toBe(false);
  });

  test('Windows Ctrl+Alt+M on a layout where it types a character still matches by physical key', () => {
    expect(isCommentShortcut(key({ ctrlKey: true, key: 'µ' }), false)).toBe(true);
  });
});

const mac = /Mac|iPhone|iPad/.test(browser.navigator.platform);
let root: Root | null = null;
let editor: InstanceType<typeof Editor> | null = null;
afterEach(async () => {
  browser.document.getSelection()?.removeAllRanges();
  await act(async () => root?.unmount());
  editor?.destroy();
  browser.document.body.replaceChildren();
  root = null;
  editor = null;
});

async function mount(props: { editable: boolean; canComment: boolean }, onComment: () => void) {
  const host = browser.document.createElement('div');
  const container = browser.document.createElement('div');
  browser.document.body.append(host, container);
  editor = new Editor({
    element: host as unknown as HTMLElement,
    extensions: [StarterKit],
    content: '<p>A selected passage.</p><p>Another paragraph.</p>',
    editable: props.editable,
  });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<DocMenus editor={editor!} blockMenu={false} {...props} onComment={onComment} />));
  return editor;
}

function select(current: InstanceType<typeof Editor>, from: number, to: number) {
  current.commands.setTextSelection({ from, to });
  const text = current.view.dom.querySelector('p')!.firstChild!;
  const range = browser.document.createRange();
  range.setStart(text as never, from - 1);
  range.setEnd(text as never, to - 1);
  browser.document.getSelection()!.removeAllRanges();
  browser.document.getSelection()!.addRange(range);
}

type Target = { dispatchEvent: (event: never) => boolean };
const press = (target: Target = browser.document.body as unknown as Target) => {
  const event = new browser.KeyboardEvent('keydown', {
    key: mac ? 'µ' : 'm', code: 'KeyM', metaKey: mac, ctrlKey: !mac, altKey: true, bubbles: true, cancelable: true,
  });
  target.dispatchEvent(event as never);
  return event;
};

describe('DocMenus comment shortcut', () => {
  for (const editable of [true, false]) {
    test(`comments on the selected text while comments are on (${editable ? 'editable' : 'comment only'})`, async () => {
      const calls: string[] = [];
      const current = await mount({ editable, canComment: true }, () => calls.push('comment'));
      select(current, 3, 11);
      const event = press((editable ? current.view.dom : browser.document.body) as unknown as Target);
      expect(calls).toEqual(['comment']);
      expect(event.defaultPrevented).toBe(true);
    });
  }

  test('does nothing without a selection, outside the editor, or with comments off', async () => {
    const calls: string[] = [];
    const current = await mount({ editable: true, canComment: true }, () => calls.push('comment'));
    current.commands.setTextSelection(3);
    expect(press().defaultPrevented).toBe(false);
    const outside = browser.document.createElement('p');
    outside.textContent = 'Text outside the editor.';
    browser.document.body.append(outside);
    current.commands.setTextSelection({ from: 3, to: 11 });
    const range = browser.document.createRange();
    range.selectNodeContents(outside as never);
    browser.document.getSelection()!.removeAllRanges();
    browser.document.getSelection()!.addRange(range);
    expect(press().defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    await act(async () => root!.render(<DocMenus editor={current} blockMenu={false} editable canComment={false} onComment={() => calls.push('comment')} />));
    select(current, 3, 11);
    expect(press().defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});
