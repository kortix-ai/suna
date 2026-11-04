import { afterEach, beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useEffect, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost' });
for (const key of [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'Text',
  'Document',
  'MutationObserver',
  'DOMParser',
  'CustomEvent',
  'KeyboardEvent',
  'MouseEvent',
  'FocusEvent',
  'InputEvent',
  'Range',
  'DOMRect',
  'NodeFilter',
  'ShadowRoot',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: key === 'window' ? browser : key === 'document' ? browser.document : browser[key],
    configurable: true,
    writable: true,
  });
}
Object.assign(globalThis, {
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  configurable: true,
});
if (!browser.Range.prototype.getClientRects)
  browser.Range.prototype.getClientRects = () => {
    const rect = new browser.DOMRect(0, 0, 10, 10);
    return Object.assign([rect], { item: () => rect });
  };
if (!browser.Range.prototype.getBoundingClientRect)
  browser.Range.prototype.getBoundingClientRect = () => new browser.DOMRect(0, 0, 10, 10);
let Composer: typeof import('./artifact-comment-composer').ArtifactCommentComposer;
const container = browser.document.createElement('div');
browser.document.body.append(container);
let root = createRoot(container as unknown as HTMLElement);
let body = '';
let submitted: string[] = [];
beforeAll(async () => {
  Composer = (await import('./artifact-comment-composer')).ArtifactCommentComposer;
});
afterEach(async () => {
  await act(async () => root.unmount());
  root = createRoot(container as unknown as HTMLElement);
  body = '';
  submitted = [];
});
function Harness({
  initial,
  ...extra
}: { initial: string } & Partial<ComponentProps<typeof Composer>>) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    body = value;
  }, [value]);
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSubmit={() => submitted.push(value)}
      mentions={[]}
      label="Comment"
      placeholder="Leave feedback"
      submitLabel="Comment"
      autoFocus
      {...extra}
    />
  );
}
async function mount(initial: string, extra: Partial<ComponentProps<typeof Composer>> = {}) {
  await act(async () => {
    root.render(<Harness initial={initial} {...extra} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const editor = container.querySelector('[contenteditable]');
  if (!(editor instanceof browser.HTMLElement))
    throw new Error('The real comment editor did not mount');
  return editor;
}
async function key(
  editor: InstanceType<typeof browser.HTMLElement>,
  options: ConstructorParameters<typeof browser.KeyboardEvent>[1],
) {
  await act(async () => {
    editor.dispatchEvent(
      new browser.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

test('the real editor sends Enter, preserves Shift+Enter and ignores composition Enter', async () => {
  const editor = await mount('Ready');
  await key(editor, { key: 'Enter', isComposing: true });
  expect(submitted).toEqual([]);
  await key(editor, { key: 'Enter', shiftKey: true });
  expect(submitted).toEqual([]);
  expect(body).toContain('\n');
  await key(editor, { key: 'Enter' });
  expect(submitted).toEqual([body]);
});

test('Enter chooses a mention before sending; the chip serializes the exact server token', async () => {
  const editor = await mount('@da', {
    mentions: [{ key: 'user:dana', kind: 'user', label: 'Dana', token: '@dana@example.test' }],
  });
  await act(async () => {
    editor.focus();
    const range = browser.document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    browser.getSelection()!.removeAllRanges();
    browser.getSelection()!.addRange(range);
    browser.document.dispatchEvent(new browser.Event('selectionchange'));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(browser.document.querySelector('[role="option"]')?.textContent).toContain('Dana');
  const activeId = editor.getAttribute('aria-activedescendant');
  expect(activeId).toBe(browser.document.querySelector('[role="option"]')?.id ?? null);
  const listId = editor.getAttribute('aria-controls');
  expect(listId && browser.document.getElementById(listId)?.getAttribute('role')).toBe('listbox');
  await key(editor, { key: 'Enter' });
  expect(submitted).toEqual([]);
  expect(body).toBe('@dana@example.test ');
  expect(editor.textContent).toContain('@Dana');
  await key(editor, { key: 'Enter' });
  expect(submitted).toEqual(['@dana@example.test ']);
});

test('a fallback UUID token remains hidden behind the existing mention chip', async () => {
  const token = '@11111111-1111-4111-8111-111111111111';
  const editor = await mount(`Hello ${token}`, {
    mentions: [{ key: 'user:dana', kind: 'user', label: 'Dana', token }],
  });
  expect(editor.textContent).toContain('@Dana');
  expect(editor.textContent).not.toContain('11111111');
  await key(editor, { key: 'Enter' });
  expect(submitted).toEqual([`Hello ${token}`]);
});

test('an empty or pending composer cannot submit', async () => {
  const editor = await mount('Ready', { pending: true });
  await key(editor, { key: 'Enter' });
  expect(submitted).toEqual([]);
  expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
});

test('clearing a submitted draft never emits its old value or restores it on the next input', async () => {
  const changes: string[] = [];
  function ClearingHarness() {
    const [value, setValue] = useState('First line\nSecond line');
    return (
      <Composer
        value={value}
        onChange={(next) => {
          changes.push(next);
          if (changes.length < 5) setValue(next);
        }}
        onSubmit={() => setValue('')}
        mentions={[]}
        label="Comment"
        placeholder="Leave feedback"
        submitLabel="Comment"
      />
    );
  }
  await act(async () => {
    root.render(<ClearingHarness />);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const dom = container.querySelector('[contenteditable]') as unknown as HTMLElement & {
    editor: import('@tiptap/core').Editor;
  };
  changes.length = 0;
  await key(dom as unknown as InstanceType<typeof browser.HTMLElement>, { key: 'Enter' });
  expect(changes).toEqual([]);
  expect(dom.editor.state.doc.textContent).toBe('');
  expect(dom.textContent).toBe('');
  await act(async () => {
    dom.editor.commands.insertContent('@ko');
  });
  expect(dom.editor.getText()).toBe('@ko');
  expect(dom.textContent).toBe('@ko');
  expect(changes).toEqual(['@ko']);
});

test('selection preparation disables submission while retaining an editable draft', async () => {
  const editor = await mount('Ready', { submitDisabled: true });
  expect(editor.getAttribute('contenteditable')).toBe('true');
  await key(editor, { key: 'Enter' });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(submitted).toEqual([]);
  expect(container.querySelector('button[type="submit"]')?.hasAttribute('disabled')).toBe(true);
  expect(body).toBe('Ready');
  await act(async () => {
    root.render(<Harness initial="Ready" submitDisabled={false} />);
  });
  await key(editor, { key: 'Enter' });
  expect(submitted).toEqual(['Ready']);
});
