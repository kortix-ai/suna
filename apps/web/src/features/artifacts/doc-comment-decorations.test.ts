import type { ArtifactCommentThread } from '@kortix/sdk';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMParser } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
  createDocCommentPlugin,
  docCommentPluginKey,
  scrollDocCommentHighlight,
} from './doc-comment-decorations';
import { markdownToHtml } from '@kortix/ui/markdown/doc-editor/markdown';

const window = new Window();
const schema = getSchema([StarterKit]);
beforeAll(() => {
  for (const key of ['window', 'document', 'DOMParser', 'MutationObserver', 'Node', 'HTMLElement'] as const) {
    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : key === 'document' ? window.document : window[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, 'getComputedStyle', { value: window.getComputedStyle.bind(window), configurable: true, writable: true });
});
const state = (markdown: string) => {
  const element = window.document.createElement('div');
  element.innerHTML = markdownToHtml(markdown);
  return EditorState.create({
    schema,
    doc: PMParser.fromSchema(schema).parse(element as unknown as HTMLElement),
    plugins: [createDocCommentPlugin(() => {})],
  });
};
const thread = (version: string): ArtifactCommentThread =>
  ({
    thread_id: 'synthetic-thread',
    anchor: { type: 'text', version, quote: 'selected', prefix: '', suffix: '' },
    status: 'open',
  }) as ArtifactCommentThread;

test('comment decorations leave the document and Markdown unchanged and follow editing transactions', () => {
  const markdown = 'A **selected** passage.\n';
  let current = state(markdown);
  const original = current.doc.toJSON();
  const transaction = current.tr.setMeta(docCommentPluginKey, {
    markdown,
    comments: [thread('commit-one')],
    focusedThreadId: 'synthetic-thread',
    label: 'Comment',
  });
  expect(transaction.docChanged).toBe(false);
  current = current.apply(transaction);
  const highlighted = docCommentPluginKey.getState(current)!.find();
  expect(highlighted).toHaveLength(1);
  expect(current.doc.toJSON()).toEqual(original);
  const before = highlighted[0]!.from;
  current = current.apply(current.tr.insertText('New ', 1));
  expect(docCommentPluginKey.getState(current)!.find()[0]!.from).toBe(before + 4);
});

test('historical decorations include only matching versions and missing quotes create no highlight', () => {
  let current = state('A selected passage.\n');
  current = current.apply(
    current.tr.setMeta(docCommentPluginKey, {
      markdown: 'A selected passage.\n',
      comments: [thread('commit-one')],
      version: 'commit-two',
      label: 'Comment',
    }),
  );
  expect(docCommentPluginKey.getState(current)!.find()).toHaveLength(0);
  current = current.apply(
    current.tr.setMeta(docCommentPluginKey, {
      markdown: 'A selected passage.\n',
      comments: [thread('commit-one')],
      version: 'commit-one',
      label: 'Comment',
    }),
  );
  expect(docCommentPluginKey.getState(current)!.find()).toHaveLength(1);
  current = state('The passage is gone.\n');
  current = current.apply(
    current.tr.setMeta(docCommentPluginKey, {
      markdown: 'The passage is gone.\n',
      comments: [thread('commit-one')],
      label: 'Comment',
    }),
  );
  expect(docCommentPluginKey.getState(current)!.find()).toHaveLength(0);
});

test('historical decorations accept the exact server-selected legacy ETag and reject another ETag', () => {
  let current = state('A selected passage.\n');
  current = current.apply(
    current.tr.setMeta(docCommentPluginKey, {
      markdown: 'A selected passage.\n',
      comments: [thread('selected-entry-etag')],
      version: 'selected-commit',
      entryVersion: 'selected-entry-etag',
      label: 'Comment',
    }),
  );
  expect(docCommentPluginKey.getState(current)!.find()).toHaveLength(1);
  current = current.apply(
    current.tr.setMeta(docCommentPluginKey, {
      markdown: 'A selected passage.\n',
      comments: [thread('unrelated-entry-etag')],
      version: 'selected-commit',
      entryVersion: 'selected-entry-etag',
      label: 'Comment',
    }),
  );
  expect(docCommentPluginKey.getState(current)!.find()).toHaveLength(0);
});

test('focus waits for a matching highlight, scrolls once across polls, and repeats only for a new focus request', () => {
  const root = window.document.createElement('div');
  let scrolls = 0;
  let handled = scrollDocCommentHighlight(root as unknown as HTMLElement, 'late-thread', 1, '');
  expect(handled).toBe('');
  const highlight = window.document.createElement('span');
  highlight.setAttribute('data-artifact-thread', 'late-thread');
  highlight.scrollIntoView = () => {
    scrolls++;
  };
  root.appendChild(highlight);
  handled = scrollDocCommentHighlight(root as unknown as HTMLElement, 'late-thread', 1, handled);
  expect(scrolls).toBe(1);
  expect(handled).not.toBe('');
  handled = scrollDocCommentHighlight(root as unknown as HTMLElement, 'late-thread', 1, handled);
  expect(scrolls).toBe(1);
  handled = scrollDocCommentHighlight(root as unknown as HTMLElement, 'late-thread', 2, handled);
  expect(scrolls).toBe(2);
  const unchanged = scrollDocCommentHighlight(
    root as unknown as HTMLElement,
    'missing-thread',
    3,
    handled,
  );
  expect(unchanged).toBe(handled);
});

for (const editable of [true, false]) {
  test(`identical thread ranges share one DOM highlight and cycle both threads with editable=${editable}`, () => {
    const markdown = 'A selected passage.\n';
    const focused: string[] = [];
    const first = { ...thread('legacy-etag'), thread_id: 'first-thread' };
    const second = { ...thread('current-commit'), thread_id: 'second-thread' };
    const current = EditorState.create({ schema, doc: state(markdown).doc, plugins: [createDocCommentPlugin((id) => focused.push(id))] });
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const view = new EditorView(host as unknown as HTMLElement, { state: current, editable: () => editable });
    try {
      const before = view.state.doc.toJSON();
      const transaction = view.state.tr.setMeta(docCommentPluginKey, { markdown, comments: [first, second], version: 'current-commit', entryVersion: 'legacy-etag', label: 'Comment' });
      expect(transaction.docChanged).toBe(false);
      view.dispatch(transaction);
      const highlights = view.dom.querySelectorAll<HTMLElement>('[data-artifact-threads]');
      expect(highlights).toHaveLength(1);
      const highlight = highlights[0]!;
      expect(highlight.getAttribute('data-artifact-threads')).toBe('first-thread second-thread');
      expect(highlight.querySelector('[role="button"]')).toBeNull();
      highlight.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent);
      highlight.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent);
      const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      highlight.dispatchEvent(enter as unknown as KeyboardEvent);
      const space = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      highlight.dispatchEvent(space as unknown as KeyboardEvent);
      expect(focused).toEqual(['first-thread', 'second-thread', 'first-thread', 'second-thread']);
      expect(enter.defaultPrevented).toBe(true);
      expect(space.defaultPrevented).toBe(true);
      expect(view.state.doc.toJSON()).toEqual(before);
      const selected = window.document.createRange();
      selected.selectNodeContents(highlight as never);
      window.document.getSelection()!.removeAllRanges();
      window.document.getSelection()!.addRange(selected);
      highlight.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent);
      expect(focused).toHaveLength(4);
      window.document.getSelection()!.removeAllRanges();
      let scrolls = 0;
      highlight.scrollIntoView = () => { scrolls++; };
      expect(scrollDocCommentHighlight(view.dom, 'second-thread', 1, '')).not.toBe('');
      expect(scrolls).toBe(1);
    } finally {
      window.document.getSelection()!.removeAllRanges();
      view.destroy();
      host.remove();
    }
  });
}

test('partially overlapping DOM highlights expose exactly the threads covering each segment', () => {
  const markdown = 'A selected passage.\n';
  const focused: string[] = [];
  const first = { ...thread('current'), thread_id: 'first-thread' };
  const second = { ...thread('current'), thread_id: 'second-thread', anchor: { type: 'text', version: 'current', quote: 'lected pass', prefix: '', suffix: '' } } as ArtifactCommentThread;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const view = new EditorView(host as unknown as HTMLElement, { state: EditorState.create({ schema, doc: state(markdown).doc, plugins: [createDocCommentPlugin((id) => focused.push(id))] }) });
  try {
    const before = view.state.doc.toJSON();
    view.dispatch(view.state.tr.setMeta(docCommentPluginKey, { markdown, comments: [first, second], label: 'Comment' }));
    const highlights = Array.from(view.dom.querySelectorAll('[data-artifact-threads]'));
    expect(highlights.map((node) => [node.textContent, node.getAttribute('data-artifact-threads')])).toEqual([
      ['se', 'first-thread'],
      ['lected', 'first-thread second-thread'],
      [' pass', 'second-thread'],
    ]);
    expect(highlights.every((node) => node.querySelector('[role="button"]') === null)).toBe(true);
    for (const index of [0, 1, 2, 1]) {
      highlights[index]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent);
    }
    expect(focused).toEqual(['first-thread', 'second-thread', 'second-thread', 'first-thread']);
    expect(view.state.doc.toJSON()).toEqual(before);
  } finally {
    view.destroy();
    host.remove();
  }
});
