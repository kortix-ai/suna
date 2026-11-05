import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactNodeViewProps } from '@tiptap/react';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// A real React editor pane: node views render through React, as in the app.
const browser = new Window({ url: 'http://localhost' });
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Document', 'MutationObserver', 'DOMParser', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'Range', 'DOMRect', 'NodeFilter', 'ShadowRoot', 'getComputedStyle', 'ClipboardEvent'] as const) {
  const value = key === 'window' ? browser : key === 'document' ? browser.document : key === 'getComputedStyle' ? browser.getComputedStyle.bind(browser) : browser[key];
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, 'ResizeObserver', { value: class { observe() {} unobserve() {} disconnect() {} }, configurable: true });

const { Editor, EditorContent } = await import('@tiptap/react');
const { docExtensions, safeNodeView } = await import('./doc-extensions');
const { htmlToMarkdown } = await import('./markdown');

/**
 * A document a writer can put in the shared Yjs doc: every attribute of the
 * wrong type. y-tiptap builds nodes from it with `schema.node`, which checks
 * no attribute type, so a remote update arrives as exactly this.
 */
const POISONED = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: { x: 1 } }, content: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      attrs: { md: { src: 5, gap: { x: 1 }, span: 'x', crlf: 'yes' } },
      content: [{ type: 'text', text: 'Linked', marks: [{ type: 'link', attrs: { href: { x: 1 }, title: 7 } }] }],
    },
    { type: 'linkEmbed', attrs: { href: { x: 1 }, title: { y: 2 }, summary: 7, image: ['a'] } },
    { type: 'linkEmbed', attrs: { href: 42, title: 'Number card' } },
    { type: 'linkEmbed', attrs: { href: ['https://example.com'], title: 'Array card' } },
    { type: 'linkEmbed', attrs: { href: 'javascript:alert(1)', title: 'Script card' } },
    { type: 'image', attrs: { src: { x: 1 }, alt: 3, uploading: 'no' } },
    { type: 'codeBlock', attrs: { language: ['ts'] }, content: [{ type: 'text', text: 'const a = 1;' }] },
    {
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: 'yes' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task' }] }] }],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', attrs: { colspan: { x: 1 }, rowspan: '2', colwidth: 'abc' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Head' }] }] },
            { type: 'tableHeader', attrs: { colspan: 5000, rowspan: 1, colwidth: [{}] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wide' }] }] },
          ],
        },
      ],
    },
  ],
};

let root: Root | null = null;
const errors: unknown[] = [];
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  errors.length = 0;
});

/** A mounted editor pane with the doc schema. */
async function mountPane(markdownHtml = '<p>Before.</p>') {
  const editor = new Editor({ extensions: docExtensions({ editable: true, placeholder: () => '' }), content: markdownHtml });
  const host = browser.document.createElement('div');
  browser.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement, { onUncaughtError: (error) => errors.push(error), onCaughtError: () => {} });
  await act(async () => root!.render(<EditorContent editor={editor} />));
  return { editor, host };
}

/** The poisoned document lands as one remote change, as y-tiptap dispatches it. */
async function receivePoison(editor: InstanceType<typeof Editor>) {
  await act(async () => {
    const content = editor.schema.nodeFromJSON(POISONED).content;
    editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, content));
  });
}

describe('a remote change with attributes of the wrong type', () => {
  test('leaves every attribute typed: invalid values fall back to their defaults', async () => {
    const { editor } = await mountPane();
    await receivePoison(editor);
    const nodes: Record<string, unknown[]> = {};
    editor.state.doc.descendants((node) => {
      (nodes[node.type.name] ??= []).push(node.attrs);
      for (const mark of node.marks) (nodes[mark.type.name] ??= []).push(mark.attrs);
    });
    expect(nodes.heading).toEqual([expect.objectContaining({ level: 1 })]);
    expect(nodes.paragraph![0]).toMatchObject({ md: null });
    expect(nodes.link).toEqual([expect.objectContaining({ href: null, title: null })]);
    // The cards: no link (the default), and a script URL is not a link either.
    expect(nodes.linkEmbed).toEqual([
      { href: '', title: '', summary: '', image: '', md: null },
      { href: '', title: 'Number card', summary: '', image: '', md: null },
      { href: '', title: 'Array card', summary: '', image: '', md: null },
      { href: 'javascript:alert(1)', title: 'Script card', summary: '', image: '', md: null },
    ]);
    expect(nodes.image).toEqual([expect.objectContaining({ src: null, alt: null, uploading: false })]);
    expect(nodes.codeBlock).toEqual([expect.objectContaining({ language: null })]);
    expect(nodes.taskItem).toEqual([expect.objectContaining({ checked: false })]);
    expect(nodes.tableHeader).toEqual([
      expect.objectContaining({ colspan: 1, rowspan: 1, colwidth: null }),
      expect.objectContaining({ colspan: 1, rowspan: 1, colwidth: null }),
    ]);
    // The file the leader writes from it.
    const saved = htmlToMarkdown(editor.getHTML());
    expect(saved).toContain('# Title');
    expect(saved).toContain('- [ ] Task');
  });

  test('the pane keeps rendering, and no card links anywhere but http(s)', async () => {
    const { editor, host } = await mountPane();
    await receivePoison(editor);
    expect(errors).toEqual([]);
    const pane = host.querySelector('.ProseMirror');
    expect(pane?.textContent).toContain('Title');
    expect(pane?.textContent).toContain('Number card');
    expect(pane?.textContent).toContain('Script card');
    const hrefs = Array.from(host.querySelectorAll('.kx-embed a, [data-node-view-wrapper] a')).map((a) => a.getAttribute('href'));
    for (const href of hrefs) expect(href === null || href === '' || /^https?:/.test(href)).toBe(true);
    // The pane still takes a person's edit.
    await act(async () => {
      // Position 1: the start of the heading's text.
      editor.commands.setTextSelection(1);
      editor.commands.insertContent('A ');
    });
    expect(pane?.textContent).toContain('A Title');
  });
});

describe('a node view that throws', () => {
  test('shows an inert placeholder for that node; the rest of the pane renders', async () => {
    function Broken(): never {
      throw new Error('synthetic node view failure');
    }
    const Safe = safeNodeView(Broken);
    const props = { node: { attrs: {} } } as unknown as ReactNodeViewProps;
    const host = browser.document.createElement('div');
    browser.document.body.appendChild(host);
    root = createRoot(host as unknown as HTMLElement, { onUncaughtError: (error) => errors.push(error), onCaughtError: () => {} });
    await act(async () =>
      root!.render(
        <div>
          <p>Around.</p>
          <Safe {...props} />
        </div>,
      ),
    );
    expect(errors).toEqual([]);
    expect(host.textContent).toContain('Around.');
    expect(host.querySelector('[data-node-error]')).not.toBeNull();
  });
});
