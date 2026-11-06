import { Extension } from '@tiptap/core';
import type { Attrs, Mark, MarkType, Node as ProseMirrorNode, NodeType } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { AddMarkStep, AddNodeMarkStep, AttrStep, RemoveMarkStep, RemoveNodeMarkStep } from '@tiptap/pm/transform';

import { sanitizeMd } from './doc-fidelity';

/**
 * A doc's node and mark attributes are untrusted: a co-editing writer can put
 * any JSON value in the shared Yjs doc, and y-tiptap builds nodes from it
 * without a type check. A node view or `renderHTML` that trusts a type
 * crashes the pane (an object as a React child, `href.replace`). Every read
 * goes through these helpers, and every change to the document is normalized
 * to the types below (`SafeAttributes`).
 */

/** A string, else `fallback`. */
export const attrString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** A string, else null. */
export const attrStringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A boolean, else `fallback`. */
export const attrBoolean = (value: unknown, fallback = false): boolean => (typeof value === 'boolean' ? value : fallback);

type Kind =
  | 'string'
  | 'string?'
  | 'boolean'
  | 'number?'
  | 'colwidth'
  | { int: readonly [min: number, max: number] };

/** A cell spans at most this many columns or rows: a table grid is built cell by cell. */
const MAX_SPAN = 1000;

/** The type of each attribute the doc schema renders. `md` (on every block) is checked by `sanitizeMd`. */
const NODE_ATTRS: Record<string, Record<string, Kind>> = {
  heading: { level: { int: [1, 6] } },
  orderedList: { start: { int: [0, 999_999_999] }, type: 'string?' },
  taskItem: { checked: 'boolean' },
  tableCell: { colspan: { int: [1, MAX_SPAN] }, rowspan: { int: [1, MAX_SPAN] }, colwidth: 'colwidth' },
  tableHeader: { colspan: { int: [1, MAX_SPAN] }, rowspan: { int: [1, MAX_SPAN] }, colwidth: 'colwidth' },
  codeBlock: { language: 'string?' },
  image: { src: 'string?', alt: 'string?', title: 'string?', width: 'number?', height: 'number?', uploading: 'boolean' },
  video: { src: 'string?', uploading: 'boolean' },
  linkEmbed: { href: 'string', title: 'string', summary: 'string', image: 'string' },
};
const MARK_ATTRS: Record<string, Record<string, Kind>> = {
  link: { href: 'string?', target: 'string?', rel: 'string?', class: 'string?', title: 'string?' },
};

/** Whether `value` has type `kind`. An attribute not in the table may hold a string, a finite number, a boolean or null. */
function valid(kind: Kind | undefined, value: unknown): boolean {
  if (kind === undefined)
    return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
  if (kind === 'string') return typeof value === 'string';
  if (kind === 'string?') return value === null || typeof value === 'string';
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'number?') return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (kind === 'colwidth')
    return (
      value === null ||
      (Array.isArray(value) && value.length <= MAX_SPAN && value.every((w) => typeof w === 'number' && Number.isFinite(w) && w >= 0))
    );
  const [min, max] = kind.int;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * `attrs` with every value of the wrong type replaced by the attribute's
 * default (`md`: its valid fields only). Null when every value is valid.
 */
export function safeAttrs(type: NodeType | MarkType, attrs: Attrs): Attrs | null {
  const table = ('isBlock' in type ? NODE_ATTRS : MARK_ATTRS)[type.name];
  let fixed: Record<string, unknown> | null = null;
  for (const [name, value] of Object.entries(attrs)) {
    let next = value;
    if (name === 'md') {
      next = sanitizeMd(value);
      if (next === value || (next === null && value == null)) continue;
    } else if (valid(table?.[name], value)) continue;
    else {
      const fallback = (type.spec.attrs as Record<string, { default?: unknown }> | undefined)?.[name]?.default;
      next = valid(table?.[name], fallback) ? fallback : null;
    }
    fixed ??= { ...attrs };
    fixed[name] = next;
  }
  return fixed;
}

/** Where `transactions` changed the document, in the final document's positions. */
function changedRanges(transactions: readonly Transaction[]): Array<[number, number]> {
  let ranges: Array<[number, number]> = [];
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    ranges = ranges.map(([from, to]) => [tr.mapping.map(from, -1), tr.mapping.map(to, 1)]);
    tr.steps.forEach((step, i) => {
      const rest = tr.mapping.slice(i + 1);
      // Steps that change attributes or marks move nothing: their own range.
      if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) {
        const at = rest.map(step.pos);
        ranges.push([at, at + 1]);
      } else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        ranges.push([rest.map(step.from, -1), rest.map(step.to, 1)]);
      } else step.getMap().forEach((_from, _to, start, end) => ranges.push([rest.map(start, -1), rest.map(end, 1)]));
    });
  }
  return ranges;
}

/** The fix of one mark, or null. */
const markFix = (mark: Mark) => {
  const attrs = safeAttrs(mark.type, mark.attrs);
  return attrs ? { mark, next: mark.type.create(attrs) } : null;
};

/**
 * Every change to the document (a remote Yjs update above all) leaves only
 * attributes of their own type: an invalid value becomes the attribute's
 * default before the view renders it. Only the changed ranges are read. The
 * fix is not an undoable step of the person's.
 */
export const SafeAttributes = Extension.create({
  name: 'safeAttributes',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('safeAttributes'),
        appendTransaction: (transactions, _old, state) => {
          const ranges = changedRanges(transactions);
          if (!ranges.length) return null;
          const { tr } = state;
          const size = state.doc.content.size;
          const fix = (node: ProseMirrorNode, pos: number) => {
            const attrs = safeAttrs(node.type, node.attrs);
            if (attrs) tr.setNodeMarkup(pos, undefined, attrs, node.marks);
            for (const change of node.marks.map(markFix)) {
              if (!change) continue;
              if (node.isInline) tr.removeMark(pos, pos + node.nodeSize, change.mark).addMark(pos, pos + node.nodeSize, change.next);
              else tr.removeNodeMark(pos, change.mark).addNodeMark(pos, change.next);
            }
          };
          for (const [from, to] of ranges) {
            const start = Math.max(0, Math.min(from, size));
            const end = Math.max(start, Math.min(to, size));
            if (start === end) {
              const $pos = state.doc.resolve(start);
              for (let depth = $pos.depth; depth > 0; depth--) fix($pos.node(depth), $pos.before(depth));
            } else state.doc.nodesBetween(start, end, fix);
          }
          if (!tr.docChanged) return null;
          return tr.setMeta('addToHistory', false);
        },
      }),
    ];
  },
});
