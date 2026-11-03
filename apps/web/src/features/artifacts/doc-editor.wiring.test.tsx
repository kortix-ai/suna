import { afterEach, beforeAll, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArtifactCommentThread, ArtifactDetail } from '@kortix/sdk';
import type { Editor } from '@tiptap/core';

const browser = new Window({ url: 'http://localhost' });
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Text', 'Document', 'MutationObserver', 'DOMParser', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'InputEvent', 'Range', 'DOMRect', 'NodeFilter', 'ShadowRoot'] as const) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? browser : key === 'document' ? browser.document : browser[key], configurable: true, writable: true });
}
Object.assign(globalThis, { getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });
const initialMarkdown = 'A selected passage.\n';
let markdown = initialMarkdown;
let saves = 0;
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useArtifactText: () => ({ data: markdown }), useArtifactMutations: () => ({ save: { mutateAsync: async () => { saves++; return { entry_version: 'saved-entry' }; } } }) }));
const toasts: string[] = [];
const toast = await import('@kortix/ui/toast');
mock.module('@kortix/ui/toast', () => ({ ...toast, errorToast: (message: string) => { toasts.push(message); } }));
const { DocEditor } = await import('./doc-editor');
const container = browser.document.createElement('div');
browser.document.body.append(container);
let root = createRoot(container as unknown as HTMLElement);
beforeAll(() => { browser.HTMLElement.prototype.scrollIntoView = () => {}; });
afterEach(async () => {
  browser.document.getSelection()?.removeAllRanges();
  await act(async () => root.unmount());
  container.replaceChildren();
  root = createRoot(container as unknown as HTMLElement);
  saves = 0;
  markdown = initialMarkdown;
  toasts.length = 0;
});
const artifact = (id: string) => ({ artifact_id: id, type: 'doc', entry: 'note.md', path: '/workspace/note.md', entry_version: 'entry', version: { id: 'commit', view_url: 'https://example.test/note.md' } }) as ArtifactDetail;
const comments = (prefix: string) => ['one', 'two'].map((id) => ({ thread_id: `${prefix}-${id}`, anchor: { type: 'text', version: 'commit', quote: 'selected', prefix: '', suffix: '' }, status: 'open', comments: [{ deleted_at: null }] })) as ArtifactCommentThread[];

function boundedMutationObservers() {
  const NativeObserver = browser.MutationObserver;
  const observers = new Set<InstanceType<typeof NativeObserver>>();
  let callbacks = 0;
  let exceeded = false;
  class BoundedObserver extends NativeObserver {
    constructor(callback: ConstructorParameters<typeof NativeObserver>[0]) {
      super((records, observer) => {
        callbacks++;
        if (callbacks > 32) {
          exceeded = true;
          for (const active of observers) active.disconnect();
          return;
        }
        callback(records, observer);
      });
      observers.add(this);
    }
  }
  Object.defineProperty(browser, 'MutationObserver', { value: BoundedObserver, configurable: true });
  Object.defineProperty(globalThis, 'MutationObserver', { value: BoundedObserver, configurable: true });
  return {
    exceeded: () => exceeded,
    restore() {
      for (const observer of observers) observer.disconnect();
      Object.defineProperty(browser, 'MutationObserver', { value: NativeObserver, configurable: true });
      Object.defineProperty(globalThis, 'MutationObserver', { value: NativeObserver, configurable: true });
    },
  };
}

for (const editable of [true, false]) {
  test(`code fences mount and retain code selection without observer churn (${editable ? 'editable' : 'read-only'})`, async () => {
    markdown = 'Before.\n\n```ts\nconst value = 1;\n```\n\nAfter.\n';
    const observers = boundedMutationObservers();
    try {
      await act(async () => root.render(<DocEditor projectId="project" artifact={artifact(`code-${editable}`)} editable={editable} onStatus={() => {}} onReload={() => {}} />));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
      expect(observers.exceeded()).toBe(false);
      const element = container.querySelector('.tiptap') as unknown as HTMLElement & { editor: Editor };
      const code = element.querySelector('[data-node-view-content-react]')!;
      expect(element.querySelectorAll('.kx-code')).toHaveLength(1);
      expect(code.textContent).toBe('const value = 1;');
      expect(element.editor.state.doc.textContent).toBe('Before.const value = 1;After.');
      expect(saves).toBe(0);
      await act(async () => {
        const range = browser.document.createRange();
        range.setStart(code.firstChild! as never, 0);
        range.setEnd(code.firstChild! as never, 5);
        const selection = browser.document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        browser.document.dispatchEvent(new browser.Event('selectionchange'));
      });
      expect(browser.document.getSelection()!.toString()).toBe('const');
      expect(element.editor.state.doc.textContent).toBe('Before.const value = 1;After.');
      if (editable) {
        await act(async () => {
          code.textContent = 'const value = 2;';
          code.dispatchEvent(new browser.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '2' }) as never);
          await new Promise((resolve) => setTimeout(resolve, 25));
        });
        expect(element.editor.state.doc.textContent).toBe('Before.const value = 2;After.');
        const language = element.querySelector('figcaption input') as HTMLInputElement;
        await act(async () => {
          language.focus();
          language.setSelectionRange(0, 2);
          browser.document.dispatchEvent(new browser.Event('selectionchange'));
        });
        expect(language.value).toBe('ts');
        expect(language.selectionStart).toBe(0);
        expect(language.selectionEnd).toBe(2);
        expect(element.editor.state.doc.textContent).toBe('Before.const value = 2;After.');
      } else {
        expect(element.querySelector('figcaption span')!.textContent).toBe('ts');
      }
      expect(observers.exceeded()).toBe(false);
      expect(element.querySelectorAll('.kx-code')).toHaveLength(1);
    } finally {
      observers.restore();
    }
  });
}

test('actual read-only DocEditor routes highlight clicks and keyboard to fresh props with two isolated editors', async () => {
  const first = artifact('first');
  const second = artifact('second');
  const firstComments = comments('first');
  const secondComments = comments('second');
  const calls: string[] = [];
  const render = (replacement = false) => <>
    <DocEditor key="first" projectId="project" artifact={first} editable={false} onStatus={() => {}} onReload={() => {}} comments={firstComments} onFocusThread={(id) => calls.push(`${replacement ? 'new' : 'old'}:${id}`)} />
    <DocEditor key="second" projectId="project" artifact={second} editable={false} onStatus={() => {}} onReload={() => {}} comments={secondComments} onFocusThread={(id) => calls.push(`second:${id}`)} />
  </>;
  await act(async () => root.render(render()));
  const highlights = Array.from(container.querySelectorAll('[data-artifact-threads]'));
  expect(highlights).toHaveLength(2);
  const before = Array.from(container.querySelectorAll('.tiptap')).map((node) => node.innerHTML);
  await act(async () => highlights[0]!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }) as never));
  expect(calls).toEqual(['old:first-one']);
  await act(async () => root.render(render(true)));
  const current = container.querySelector('[data-artifact-threads~="first-one"]')!;
  await act(async () => current.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }) as never));
  await act(async () => current.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as never));
  await act(async () => container.querySelector('[data-artifact-threads~="second-one"]')!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, cancelable: true }) as never));
  expect(calls).toEqual(['old:first-one', 'new:first-two', 'new:first-one', 'second:second-one']);
  expect(Array.from(container.querySelectorAll('.tiptap')).map((node) => node.innerHTML)).toEqual(before);
  expect(saves).toBe(0);
});

for (const [label, words, outcome] of [
  ['a 299-character paragraph anchors whole', 59, 'anchor'],
  ['a 554-character paragraph is refused with the limit', 110, 'refused'],
] as const) {
  test(`the comment shortcut on a read-only DocEditor: ${label}`, async () => {
    markdown = `${'word '.repeat(words)}end.\n`;
    const anchors: string[] = [];
    await act(async () => root.render(
      <DocEditor projectId="project" artifact={artifact(`shortcut-${words}`)} editable={false} onStatus={() => {}} onReload={() => {}}
        canComment onComment={(anchor) => anchors.push(anchor.quote)} readCommentSnapshot={async () => ({ version: 'commit', text: markdown })} />,
    ));
    const element = container.querySelector('.tiptap') as unknown as HTMLElement & { editor: Editor };
    const text = element.querySelector('p')!.firstChild!;
    await act(async () => {
      element.editor.commands.setTextSelection({ from: 1, to: element.editor.state.doc.content.size - 1 });
      const range = browser.document.createRange();
      range.selectNodeContents(text as never);
      browser.document.getSelection()!.removeAllRanges();
      browser.document.getSelection()!.addRange(range);
    });
    const mac = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
    await act(async () => {
      browser.document.body.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'm', code: 'KeyM', metaKey: mac, ctrlKey: !mac, altKey: true, bubbles: true, cancelable: true }) as never);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const paragraph = markdown.trimEnd();
    if (outcome === 'anchor') {
      expect(anchors).toEqual([paragraph]);
      expect(toasts).toEqual([]);
      // The passage now lives in the composer: the selection collapses, so the formatting bubble hides.
      expect(element.editor.state.selection.empty).toBe(true);
    } else {
      expect(anchors).toEqual([]);
      expect(toasts).toEqual(['This passage is too long to comment on. Select 500 characters or fewer.']);
    }
    expect(saves).toBe(0);
  });
}

test('actual editable DocEditor forwards slash-menu keys through its configured extension', async () => {
  await act(async () => root.render(<DocEditor projectId="project" artifact={artifact('slash')} editable onStatus={() => {}} onReload={() => {}} />));
  const element = container.querySelector('.tiptap') as unknown as HTMLElement & { editor: Editor };
  expect(element).not.toBeNull();
  await act(async () => {
    element.editor.view.focus();
    element.editor.commands.setContent('<p>/</p>');
    element.editor.commands.setTextSelection(2);
  });
  const menu = browser.document.querySelector('[role="listbox"]');
  expect(menu).not.toBeNull();
  expect(menu!.querySelector('[aria-selected="true"]')!.textContent).toContain('Heading 1');
  await act(async () => element.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }) as never));
  expect(menu!.querySelector('[aria-selected="true"]')!.textContent).toContain('Heading 2');
});
