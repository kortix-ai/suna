import { Editor, Node, mergeAttributes } from '@tiptap/core';

import type { MentionKind } from '../types';

export interface MentionAttrs {
  kind: MentionKind;
  label: string;
  value: string;
}

/**
 * An indivisible inline badge.
 *
 * `atom: true` is the entire point: the caret can never land inside the badge,
 * one backspace removes it whole, and every occurrence is a distinct node. The
 * string model it replaces could do none of these — `text.indexOf(needle)`
 * found only the FIRST match, so a second `@README.md` rendered as plain text.
 */
export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      kind: { default: 'file' as MentionKind },
      label: { default: '' },
      value: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const label = String(node.attrs.label ?? '');
    const kind = String(node.attrs.kind ?? 'file');
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-mention': kind,
        'aria-label': `${kind} mention: ${label}`,
        class:
          'bg-muted text-foreground rounded-md px-1 py-0.5 text-[0.9em] font-medium ' +
          'whitespace-nowrap align-baseline',
      }),
      `@${label}`,
    ];
  },

  renderText({ node }) {
    return `@${node.attrs.label}`;
  },
});

/**
 * Turn a picked menu item into a node in the document. This is the only
 * place that knows the insertion shape (mention node + trailing space so the
 * user can keep typing without first pressing space themselves) — the menus
 * that call it (Milestone 3) only need to know kind/label/value.
 */
export function insertMention(editor: Editor, attrs: MentionAttrs): void {
  editor
    .chain()
    .focus()
    .insertContent([
      { type: MentionNode.name, attrs },
      { type: 'text', text: ' ' },
    ])
    .run();
}
