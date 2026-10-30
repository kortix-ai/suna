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
const markdown = 'A selected passage.\n';
let saves = 0;
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useArtifactText: () => ({ data: markdown }), useArtifactMutations: () => ({ save: { mutateAsync: async () => { saves++; return { entry_version: 'saved-entry' }; } } }) }));
const { DocEditor } = await import('./doc-editor');
const container = browser.document.createElement('div');
browser.document.body.append(container);
let root = createRoot(container as unknown as HTMLElement);
beforeAll(() => { browser.HTMLElement.prototype.scrollIntoView = () => {}; });
afterEach(async () => {
  await act(async () => root.unmount());
  container.replaceChildren();
  root = createRoot(container as unknown as HTMLElement);
  saves = 0;
});
const artifact = (id: string) => ({ artifact_id: id, type: 'doc', entry: 'note.md', path: '/workspace/note.md', entry_version: 'entry', version: { id: 'commit', view_url: 'https://example.test/note.md' } }) as ArtifactDetail;
const comments = (prefix: string) => ['one', 'two'].map((id) => ({ thread_id: `${prefix}-${id}`, anchor: { type: 'text', version: 'commit', quote: 'selected', prefix: '', suffix: '' }, status: 'open' })) as ArtifactCommentThread[];

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
