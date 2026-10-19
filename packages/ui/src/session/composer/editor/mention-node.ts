import { Editor, Node, mergeAttributes } from '@tiptap/core';

import { chipAriaLabel, chipClass, chipText } from '../../mention-chip';
import type { ChipKind } from '../types';

export interface MentionAttrs {
  kind: ChipKind;
  label: string;
  value: string;
}

// `chipPrefix` / `chipText` / `chipClass` / `chipAriaLabel` used to live here.
// They moved to `features/session/mention-chip.tsx` so the SENT message can
// draw the identical chip — see that module's header for what was broken
// while this file was their only home. Re-exported because this node is the
// composer's canonical entry point for them.
export { chipAriaLabel, chipClass, chipPrefix, chipText } from '../../mention-chip';

/**
 * An indivisible inline badge — an `@` mention or a `/` command.
 *
 * `atom: true` is the entire point: the caret can never land inside the badge,
 * one backspace removes it whole, and every occurrence is a distinct node. The
 * string model it replaces could do none of these — `text.indexOf(needle)`
 * found only the FIRST match, so a second `@README.md` rendered as plain text.
 *
 * The node is named `mention` for both kinds rather than split into a second
 * node type. One atom means one schema entry, one `parseHTML` contract, one
 * serializer walk (`serialize.ts`), and — the reason that matters here — one
 * set of atom semantics: a command chip gets whole-node backspace, drag-safe
 * boundaries, and survives the `getDocument`/`setDocument` round trip that
 * failed-send recovery and the question lock depend on, for free. What
 * separates the two kinds is `kind`, read at render and at serialize time.
 */
export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  // Each attribute renders to (and parses back from) its own `data-*`
  // attribute. Without this, TipTap's default per-attribute fallback would
  // still round-trip `kind`/`label`/`value` as bare, non-namespaced HTML
  // attributes (`kind="file"`) — which happens to work but collides with
  // `value`'s real HTML meaning on form elements and isn't the documented
  // wire shape. Explicit `data-mention-*` names are what `parseHTML()`'s
  // `span[data-mention]` selector below is actually meant to read back.
  addAttributes() {
    return {
      kind: {
        default: 'file' as ChipKind,
        parseHTML: (element) => element.getAttribute('data-mention') as ChipKind | null,
        renderHTML: (attrs) => ({ 'data-mention': attrs.kind }),
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-mention-label'),
        renderHTML: (attrs) => ({ 'data-mention-label': attrs.label }),
      },
      value: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-mention-value'),
        renderHTML: (attrs) => ({ 'data-mention-value': attrs.value }),
      },
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
        'aria-label': chipAriaLabel(kind, label),
        class: chipClass(kind),
      }),
      chipText(kind, label),
    ];
  },

  /**
   * Feeds TipTap's own `editor.getText()` helper only — `serialize.ts`'s
   * `textBetween` passes an explicit `leafText` callback, which ProseMirror
   * prioritises over `spec.toText` (what this compiles to). The two are kept
   * deliberately identical, INCLUDING the command case: a command chip
   * contributes NOTHING to the message text on either path, because it is not
   * body text — it leaves the composer through `onCommand(command, args)`,
   * and the text that remains IS the args. Returning `/name` here would
   * silently prepend the command name to its own arguments.
   */
  renderText({ node }) {
    if (node.attrs.kind === 'command') return '';
    return `@${node.attrs.label}`;
  },
});

/**
 * Turn a picked menu item into a node in the document. This is the only
 * place that knows the insertion shape (chip node + trailing space so the
 * user can keep typing without first pressing space themselves) — the menus
 * that call it only need to know kind/label/value.
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

/**
 * Insert a `/` command as an inline chip.
 *
 * This is the whole of the "commands behave like mentions" change. The command
 * used to leave the document entirely and become shell state
 * (`composer.tsx`'s `stagedCommand`), which forced the `/` menu to be fed an
 * empty command list for as long as it was staged — so `/` visibly stopped
 * working after the first pick. As a chip it stays in the document: the menu
 * is never suppressed, `/` opens as many times as you press it, backspace
 * removes the chip whole, and the args are simply whatever text sits around
 * it.
 *
 * `value` carries the command NAME, not the `Command` object. Node attributes
 * have to survive a JSON round trip (`getDocument`/`setDocument`, used by
 * failed-send recovery and the question lock), and the resolved `Command` is
 * looked back up from the live list at submit time — so a chip can never go
 * stale against a command list that changed underneath it.
 */
export function insertCommandChip(editor: Editor, name: string): void {
  insertMention(editor, { kind: 'command', label: name, value: name });
}
