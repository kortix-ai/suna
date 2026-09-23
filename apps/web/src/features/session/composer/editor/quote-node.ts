import { Editor, Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { serializeReplyContext } from '../../reply-context';

export interface QuoteNodeOptions {
  /**
   * The remove button's `aria-label`. A getter, not a string, for the same
   * reason `baseExtensions(getPlaceholder)` takes one (see extensions.ts):
   * `Editor.setOptions()` never rebuilds extensions, so a string would be
   * frozen at whatever locale was active when the editor was first built.
   * A plain-DOM node view also cannot call the React translator itself.
   */
  getRemoveLabel: () => string;
}

// The sent-message quote (`turn/user-message.tsx`, `QuotedMessageBody`'s
// blockquote) — a left rule, not a card. The composer quote must read as the
// same object before and after send, so these are its classes verbatim plus
// the row layout the remove button needs. `my-1` separates it from the
// paragraphs around it; the paragraphs themselves carry no margin.
const QUOTE_CLASS = 'border-border my-1 flex items-start gap-1 border-l-2 pl-2.5';
const QUOTE_TEXT_CLASS = 'text-muted-foreground line-clamp-2 min-w-0 flex-1 text-sm leading-5';
// `bg-active` is the persistent-selection token. A NodeSelection on an atom
// otherwise paints nothing, so Backspace would delete a quote the user could
// not see was selected.
const QUOTE_SELECTED_CLASS = 'bg-active';
// Copied from the reply bar this node replaces: `Button variant="ghost"
// size="icon-xs"` plus the bar's own muted/hover classes. `buttonVariants` is
// the Button's own class builder, so the two cannot drift.
const REMOVE_BUTTON_CLASS = cn(
  buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
  'text-muted-foreground hover:text-foreground shrink-0 transition-colors',
);
// Phosphor `XIcon`, bold weight — the glyph the old bar's `<Close
// className="size-3" />` drew under `DEFAULT_ICON_WEIGHT = 'bold'`
// (`lib/icons/icon-config.ts`). Copied from
// `@phosphor-icons/react/dist/defs/X.es.js` because a plain-DOM node view
// cannot render the React icon. If the app-wide weight changes, update this.
const X_ICON_PATH =
  'M208.49,191.51a12,12,0,0,1-17,17L128,145,64.49,208.49a12,12,0,0,1-17-17L111,128,47.51,64.49a12,12,0,0,1,17-17L128,111l63.51-63.52a12,12,0,0,1,17,17L145,128Z';
const SVG_NS = 'http://www.w3.org/2000/svg';

function createXIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'size-3');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', X_ICON_PATH);
  svg.append(path);
  return svg;
}

/**
 * Delete the quote at `pos`. What the remove button does on click — pulled
 * out of the node view so it is testable without a DOM.
 *
 * A no-op when `pos` does not hold a quote (the node view's `getPos` can
 * return `undefined` once its node is gone) and while the editor is not
 * editable: `editable: false` blocks typing, not programmatic transactions,
 * so a disabled composer would otherwise still lose a quote to a click.
 */
export function removeQuoteAt(editor: Editor, pos: number | undefined): void {
  if (typeof pos !== 'number' || !editor.isEditable) return;
  const node = editor.state.doc.nodeAt(pos);
  if (node?.type.name !== QuoteNode.name) return;
  editor
    .chain()
    .focus()
    .deleteRange({ from: pos, to: pos + node.nodeSize })
    .run();
}

/**
 * Backspace at the start of a paragraph directly after a quote, or Delete at
 * the end of one directly before a quote: select the quote and claim the key.
 *
 * Without this the core keymap's `joinBackward`/`joinForward` deletes an atom
 * neighbour outright, so one keystroke from the reply line removed a quote
 * the user never saw selected. Selecting first makes the second press the
 * delete (a NodeSelection plus Backspace/Delete removes the atom whole), the
 * same two-step every chat composer uses for a block it cannot edit into.
 */
function selectAdjacentQuote(editor: Editor, direction: 'before' | 'after'): boolean {
  const { selection } = editor.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $pos = selection.$from;
  if (!$pos.parent.isTextblock || $pos.depth === 0) return false;
  const container = $pos.node($pos.depth - 1);
  const index = $pos.index($pos.depth - 1);
  if (direction === 'before') {
    if ($pos.parentOffset !== 0) return false;
    const sibling = container.maybeChild(index - 1);
    if (sibling?.type.name !== QuoteNode.name) return false;
    return editor.commands.setNodeSelection($pos.before() - sibling.nodeSize);
  }
  if ($pos.parentOffset !== $pos.parent.content.size) return false;
  const sibling = container.maybeChild(index + 1);
  if (sibling?.type.name !== QuoteNode.name) return false;
  return editor.commands.setNodeSelection($pos.after());
}

/**
 * A quoted passage from the transcript, as a block in the composer document.
 *
 * Each "Reply" on a transcript selection inserts one (`insertQuoteAtEnd` in
 * composer-editor.tsx), so a draft can hold N quotes with the user's reply
 * typed under each. On send, `serialize.ts` writes each one IN PLACE as a
 * `<reply_context>` block on its own line; `textToParagraphs`
 * (composer-logic.ts) turns those blocks back into this node.
 *
 * `atom: true` — same contract as `MentionNode`: the caret never lands inside
 * the quote, a NodeSelection plus Backspace deletes it whole, and it survives
 * the `getDocument`/`setDocument` JSON round trip that drafts and failed-send
 * recovery use. `text` is the only attribute, and it is always trimmed.
 *
 * Rendered with a plain-DOM node view, not a React one: the node is static
 * apart from its remove button, and a React node view would mount a React
 * root per quote.
 */
export const QuoteNode = Node.create<QuoteNodeOptions>({
  name: 'replyQuote',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { getRemoveLabel: () => '' };
  },

  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-reply-quote') ?? '',
        renderHTML: (attrs) => ({ 'data-reply-quote': attrs.text }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'blockquote[data-reply-quote]' }];
  },

  // Clipboard HTML and any non-view render. The live editor draws the node
  // view below instead.
  renderHTML({ HTMLAttributes, node }) {
    return [
      'blockquote',
      mergeAttributes(HTMLAttributes, { class: QUOTE_CLASS }),
      ['p', { class: QUOTE_TEXT_CLASS }, String(node.attrs.text ?? '')],
    ];
  },

  /**
   * Feeds TipTap's `editor.getText()` and clipboard text only — identical to
   * `serialize.ts`'s `leafText` for this node, for the reason `MentionNode`'s
   * `renderText` gives: the two paths must never disagree.
   */
  renderText({ node }) {
    return serializeReplyContext(String(node.attrs.text ?? '').trim());
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => selectAdjacentQuote(this.editor, 'before'),
      Delete: () => selectAdjacentQuote(this.editor, 'after'),
    };
  },

  addNodeView() {
    const getRemoveLabel = this.options.getRemoveLabel;
    return ({ node, getPos, editor }) => {
      let current = node;

      const dom = document.createElement('blockquote');
      dom.setAttribute('data-reply-quote', String(current.attrs.text ?? ''));
      dom.setAttribute('contenteditable', 'false');
      dom.className = QUOTE_CLASS;

      const text = document.createElement('p');
      text.className = QUOTE_TEXT_CLASS;
      text.textContent = String(current.attrs.text ?? '');

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = REMOVE_BUTTON_CLASS;
      remove.setAttribute('aria-label', getRemoveLabel());
      remove.append(createXIcon());
      // `mousedown` default would move the editor selection onto the node
      // before `click` fires; the remove action sets its own selection.
      remove.addEventListener('mousedown', (event) => event.preventDefault());
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        removeQuoteAt(editor, getPos());
      });

      dom.append(text, remove);

      return {
        dom,
        // The button owns its own events; ProseMirror must not turn a click
        // on it into a node selection.
        stopEvent: (event) =>
          event.target instanceof globalThis.Node && remove.contains(event.target),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add(QUOTE_SELECTED_CLASS),
        deselectNode: () => dom.classList.remove(QUOTE_SELECTED_CLASS),
        update: (updated) => {
          if (updated.type !== current.type) return false;
          if (updated.attrs.text !== current.attrs.text) return false;
          current = updated;
          // Locale can change between renders; the label is read live.
          remove.setAttribute('aria-label', getRemoveLabel());
          return true;
        },
      };
    };
  },
});
