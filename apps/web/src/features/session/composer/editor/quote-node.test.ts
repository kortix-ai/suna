import { Editor, getSchema } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseExtensions } from './extensions';
import { MentionNode } from './mention-node';
import { QuoteNode, removeQuoteAt } from './quote-node';

/**
 * Same house pattern as mention-node.test.ts: no jsdom/happy-dom is
 * registered for `bun test`, so these drive the real `@tiptap/core` schema
 * and a headless `Editor` directly. The plain-DOM node view (`addNodeView`)
 * needs `document`; its describe block below supplies a minimal stand-in.
 */
const schema = getSchema([Document, Paragraph, Text, QuoteNode]);

function quoteDoc(...blocks: unknown[]) {
  return PMNode.fromJSON(schema, { type: 'doc', content: blocks });
}

const quoteJSON = (text: string) => ({ type: 'replyQuote', attrs: { text } });
const paragraphJSON = (text?: string) => ({
  type: 'paragraph',
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});

describe('QuoteNode schema', () => {
  test('is a selectable, non-draggable block atom named replyQuote', () => {
    const type = schema.nodes.replyQuote;
    expect(type).toBeDefined();
    expect(type.isBlock).toBe(true);
    expect(type.isAtom).toBe(true);
    expect(type.isLeaf).toBe(true);
    expect(type.spec.selectable).toBe(true);
    expect(type.spec.draggable).toBe(false);
    expect(type.spec.group).toBe('block');
  });

  test('text defaults to an empty string', () => {
    expect(schema.nodes.replyQuote.create().attrs.text).toBe('');
  });

  test('renders a blockquote carrying the text in data-reply-quote', () => {
    const node = schema.nodes.replyQuote.create({ text: 'a quoted passage' });
    const spec = schema.nodes.replyQuote.spec.toDOM?.(node) as unknown as [
      string,
      Record<string, string>,
      ...unknown[],
    ];
    expect(spec[0]).toBe('blockquote');
    expect(spec[1]['data-reply-quote']).toBe('a quoted passage');
  });

  test('parses back from blockquote[data-reply-quote]', () => {
    const rule = schema.nodes.replyQuote.spec.parseDOM?.[0];
    expect(rule?.tag).toBe('blockquote[data-reply-quote]');
    // The attribute-level parseHTML lives on the attr spec TipTap compiles
    // into `getAttrs`; drive it with a minimal element stand-in.
    const element = {
      getAttribute: (name: string) => (name === 'data-reply-quote' ? 'round trip' : null),
    } as unknown as HTMLElement;
    const attrs = rule && 'getAttrs' in rule ? rule.getAttrs?.(element) : null;
    expect(attrs).toEqual({ text: 'round trip' });
  });

  test('a doc can hold quotes interleaved with paragraphs', () => {
    const doc = quoteDoc(
      quoteJSON('first'),
      paragraphJSON('reply one'),
      quoteJSON('second'),
      paragraphJSON('reply two'),
    );
    expect(doc.childCount).toBe(4);
    expect(doc.child(2).attrs.text).toBe('second');
  });

  test('deleting a NodeSelection on the quote removes it whole in one step', () => {
    // The "Backspace on a selected quote" half that is provable headless:
    // an atom under a NodeSelection is deleted as one unit.
    const doc = quoteDoc(quoteJSON('drop me'), paragraphJSON('keep me'));
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 0) });
    const next = state.apply(state.tr.deleteSelection());
    expect(next.doc.childCount).toBe(1);
    expect(next.doc.textContent).toBe('keep me');
  });
});

describe('removeQuoteAt — the remove button action', () => {
  function editorWith(content: unknown[]) {
    return new Editor({
      extensions: [...baseExtensions(() => ''), MentionNode, QuoteNode],
      content: { type: 'doc', content } as never,
    });
  }

  test('deletes exactly the quote at the given position, text around it untouched', () => {
    const editor = editorWith([
      paragraphJSON('before'),
      quoteJSON('remove this'),
      paragraphJSON('after'),
    ]);
    const pos = editor.state.doc.child(0).nodeSize;

    removeQuoteAt(editor, pos);

    expect(editor.getJSON().content).toEqual([paragraphJSON('before'), paragraphJSON('after')]);
  });

  test('is a no-op for a position that does not hold a quote', () => {
    const editor = editorWith([paragraphJSON('only text')]);
    const before = editor.getJSON();

    removeQuoteAt(editor, 0);
    removeQuoteAt(editor, undefined);

    expect(editor.getJSON()).toEqual(before);
  });

  test('is a no-op while the editor is not editable (a disabled composer)', () => {
    const editor = editorWith([quoteJSON('locked'), paragraphJSON()]);
    editor.setEditable(false, false);

    removeQuoteAt(editor, 0);

    expect(editor.state.doc.child(0).type.name).toBe('replyQuote');
  });
});

/**
 * Press a key through the editor's REAL keymap plugins, in plugin order — the
 * same `someProp('handleKeyDown')` walk ProseMirror does for a real keydown,
 * so extension priority is part of what is tested.
 *
 * A headless editor never mounts a view, and plugins are only installed on
 * mount (`editor.state.plugins` is empty here), so the list comes from
 * `extensionManager.plugins` — the exact array `createView` would install.
 * The view is a stand-in exposing only what keymap bindings read (`state`,
 * `dispatch`), and the event only the fields `prosemirror-keymap` reads.
 */
function pressKey(editor: Editor, key: 'Backspace' | 'Delete'): boolean {
  const view = {
    get state() {
      return editor.state;
    },
    dispatch: (tr: Transaction) => editor.view.dispatch(tr),
    composing: false,
  } as unknown as EditorView;
  const event = {
    key,
    keyCode: key === 'Backspace' ? 8 : 46,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
  for (const plugin of editor.extensionManager.plugins) {
    const handle = plugin.props.handleKeyDown;
    if (handle?.call(plugin, view, event)) return true;
  }
  return false;
}

describe('QuoteNode keyboard — a quote is selected before it is deleted', () => {
  function editorWith(content: unknown[]) {
    return new Editor({
      extensions: [...baseExtensions(() => ''), MentionNode, QuoteNode],
      content: { type: 'doc', content } as never,
    });
  }

  test('Backspace at the start of the paragraph after a quote SELECTS the quote', () => {
    const editor = editorWith([quoteJSON('keep me'), paragraphJSON('my reply')]);
    const quoteSize = editor.state.doc.child(0).nodeSize;
    // Start of the paragraph's content: past the quote and the paragraph open.
    editor.commands.setTextSelection(quoteSize + 1);

    expect(pressKey(editor, 'Backspace')).toBe(true);

    expect(editor.state.doc.child(0).type.name).toBe('replyQuote');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('replyQuote');
  });

  test('a second Backspace deletes the selected quote and keeps the reply', () => {
    const editor = editorWith([quoteJSON('drop me'), paragraphJSON('my reply')]);
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);

    pressKey(editor, 'Backspace');
    pressKey(editor, 'Backspace');

    expect(editor.getJSON().content).toEqual([paragraphJSON('my reply')]);
  });

  test('Delete at the end of the paragraph before a quote SELECTS the quote', () => {
    const editor = editorWith([paragraphJSON('intro'), quoteJSON('keep me')]);
    // End of "intro": paragraph open (1) + 5 characters.
    editor.commands.setTextSelection(1 + 'intro'.length);

    expect(pressKey(editor, 'Delete')).toBe(true);

    expect(editor.state.doc.child(1).type.name).toBe('replyQuote');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe('replyQuote');
  });

  test('a second Delete deletes the selected quote and keeps the text', () => {
    const editor = editorWith([paragraphJSON('intro'), quoteJSON('drop me')]);
    editor.commands.setTextSelection(1 + 'intro'.length);

    pressKey(editor, 'Delete');
    pressKey(editor, 'Delete');

    expect(editor.getJSON().content).toEqual([paragraphJSON('intro')]);
  });

  test('Backspace inside a paragraph is not claimed — the browser deletes the character', () => {
    const editor = editorWith([quoteJSON('untouched'), paragraphJSON('abc')]);
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 3);
    const before = editor.getJSON();

    expect(pressKey(editor, 'Backspace')).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });
});

// ── The plain-DOM node view ───────────────────────────────────────────────
//
// No DOM is registered for `bun test`, and the node view only needs a handful
// of element methods, so `document` is a minimal stand-in while the view is
// built (see `mountQuoteView`). The node view is built through
// `extensionManager.nodeViews` — the exact factory a mounted editor installs.

type Listener = (event: { target: unknown; preventDefault: () => void }) => void;

class FakeElement {
  className = '';
  textContent = '';
  type = '';
  readonly children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) {
    if (name === 'class') this.className = value;
    else this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return name === 'class' ? this.className : (this.attributes.get(name) ?? null);
  }
  append(...nodes: FakeElement[]) {
    this.children.push(...nodes);
  }
  contains(node: unknown): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, preventDefault: () => {} });
    }
  }
  get classList() {
    const tokens = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (token: string) => {
        if (!tokens().includes(token)) this.className = [...tokens(), token].join(' ');
      },
      remove: (token: string) => {
        this.className = tokens()
          .filter((t) => t !== token)
          .join(' ');
      },
      contains: (token: string) => tokens().includes(token),
    };
  }
}

describe('QuoteNode node view — the DOM the composer draws', () => {
  function mountQuoteView(label: () => string) {
    const editor = new Editor({
      extensions: [
        ...baseExtensions(() => ''),
        MentionNode,
        QuoteNode.configure({ getRemoveLabel: label }),
      ],
      content: {
        type: 'doc',
        content: [quoteJSON('a quoted passage'), paragraphJSON('reply')],
      } as never,
    });
    const factory = editor.extensionManager.nodeViews.replyQuote!;
    // `document` is stubbed only around the factory call. Present during
    // `new Editor`, it makes TipTap mount a real ProseMirror view.
    const g = globalThis as { document?: unknown };
    const savedDocument = g.document;
    g.document = {
      createElement: (tag: string) => new FakeElement(tag),
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    };
    let view: {
      dom: FakeElement;
      selectNode: () => void;
      deselectNode: () => void;
      update: (node: PMNode) => boolean;
    };
    try {
      view = factory(editor.state.doc.child(0), editor.view, () => 0, [], {} as never) as never;
    } finally {
      g.document = savedDocument;
    }
    const button = view.dom.children.find((child) => child.tagName === 'button')!;
    return { editor, view, button };
  }

  test('draws the quote text and an X button carrying the remove label', () => {
    const { view, button } = mountQuoteView(() => 'Remove quote');

    expect(view.dom.tagName).toBe('blockquote');
    expect(view.dom.children[0]!.textContent).toBe('a quoted passage');
    expect(button).toBeDefined();
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Remove quote');
  });

  test('clicking the X removes the quote and keeps the reply', () => {
    const { editor, button } = mountQuoteView(() => 'Remove quote');

    button.dispatch('click');

    expect(editor.getJSON().content).toEqual([paragraphJSON('reply')]);
  });

  test('selectNode paints the selected class; deselectNode removes it', () => {
    const { view } = mountQuoteView(() => 'Remove quote');

    view.selectNode();
    expect(view.dom.classList.contains('bg-active')).toBe(true);

    view.deselectNode();
    expect(view.dom.classList.contains('bg-active')).toBe(false);
  });

  test('the label is read live: a locale change reaches the button on update', () => {
    let label = 'Remove quote';
    const { editor, view, button } = mountQuoteView(() => label);

    label = 'Zitat entfernen';
    view.update(editor.state.doc.child(0));

    expect(button.getAttribute('aria-label')).toBe('Zitat entfernen');
  });
});

describe('remove-quote label — every locale defines it', () => {
  const locales = ['en', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'sr', 'zh'];

  // A loop, not `test.each`: this repo's `@types/bun` does not type it.
  for (const locale of locales) {
    test(`${locale} has a non-empty removeQuoteAriaLabel`, () => {
      const messages = JSON.parse(
        readFileSync(join(import.meta.dir, `../../../../../translations/${locale}.json`), 'utf8'),
      ) as { hardcodedUi: { componentsSessionSessionChatInput: Record<string, string> } };
      const section = messages.hardcodedUi.componentsSessionSessionChatInput;
      expect(section.removeQuoteAriaLabel?.length ?? 0).toBeGreaterThan(0);
      // The reply bar's old key is gone; nothing reads it any more.
      expect(section.line2078JsxAttrAriaLabelClearReply).toBeUndefined();
    });
  }
});
