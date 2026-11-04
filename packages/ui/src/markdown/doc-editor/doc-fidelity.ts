import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * What the doc editor keeps of a Markdown file's own spelling, so a block
 * nobody edited saves byte for byte (`markdown.ts`). It rides on each
 * top-level block as one attribute, `md`, written as `data-md` JSON. Every
 * field is absent when the editor already writes the file that way.
 */
export type MdBlock = {
  /** The text between the previous block and this one, when it is not one blank line (nothing, before the first block). */
  gap?: string;
  /**
   * The kinds of the two blocks `gap` was read between (`heading>paragraph`,
   * `^>heading` at the start of the file). `gap` applies only between the
   * same two kinds: a split, a deleted neighbour or a new block type gets the
   * standard blank line, so blocks never merge on the next open.
   */
  pair?: string;
  /** The end of the file after this block, when it is not one newline (`''`: no final newline). */
  end?: string;
  /**
   * The block as the file spells it (`* item`, `Title\n===`, `|a|b|`), and
   * the hash of what the editor writes for it. While the editor still writes
   * that (nobody edited the block), the file keeps `src`.
   */
  src?: string;
  norm?: string;
  /**
   * How many editor blocks `src` covers, when more than one: the editor splits
   * `Before ![chart](c.png) after.` into a paragraph, an image and a
   * paragraph. `norm` is then the hash of all of them, one blank line apart.
   */
  span?: number;
  /** The file's lines end in CRLF. */
  crlf?: true;
};

/** The block attribute's HTML name. */
export const MD_ATTRIBUTE = 'data-md';

/** A raw block's HTML marker: `<pre data-raw-markdown>` holds Markdown the editor keeps as text. */
export const RAW_ATTRIBUTE = 'data-raw-markdown';

/** Co-editing and the source-keeping analysis stop at 1 MiB of UTF-8. */
export const MAX_DOC_BYTES = 1_048_576;

/**
 * A `gap` or an `end` the file may take: blank lines only (spaces, tabs,
 * newlines), as the converter reads them. Anything else in one is text the
 * editor does not show, so it is ignored.
 */
export const LAYOUT_WHITESPACE = /^[ \t\n]*$/;

export function readMd(el: Element): MdBlock | null {
  const raw = el.getAttribute(MD_ATTRIBUTE);
  if (!raw) return null;
  try {
    return sanitizeMd(JSON.parse(raw));
  } catch {
    return null;
  }
}

const MD_STRINGS = new Set(['gap', 'pair', 'end', 'src', 'norm']);
const mdField = (key: string, value: unknown) =>
  MD_STRINGS.has(key)
    ? typeof value === 'string'
    : key === 'span'
      ? typeof value === 'number' && Number.isInteger(value) && value > 1 && value <= 10_000
      : key === 'crlf' && value === true;

/**
 * `md` with only its known fields of their own type (a writer can set any
 * JSON value): the same object when it is valid, null when nothing is left.
 */
export function sanitizeMd(value: unknown): MdBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.every(([key, field]) => mdField(key, field))) return entries.length ? (value as MdBlock) : null;
  const kept = entries.filter(([key, field]) => mdField(key, field));
  return kept.length ? (Object.fromEntries(kept) as MdBlock) : null;
}

export function writeMd(md: MdBlock | null | undefined): string | null {
  return md && Object.keys(md).length ? JSON.stringify(md) : null;
}

/** cyrb53: a 53-bit string hash, base 36. Collisions are ~1 in 9·10^15. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The block kind `pair` names: one word per top-level element of the editor's HTML. */
export function blockKind(el: Element): string {
  if (el.hasAttribute(RAW_ATTRIBUTE)) return 'raw';
  const tag = el.nodeName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'ul' && el.getAttribute('data-type') === 'taskList') return 'tasks';
  return tag;
}

/** Every node that can be a top-level block of a doc. */
const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'horizontalRule',
  'table',
  'image',
  'video',
  'linkEmbed',
  'rawMarkdown',
];

/** Pasted HTML without the file's bookkeeping: `md` and the raw-block marker come only from the file. */
export function stripMarkdownSource(html: string): string {
  if (!html.includes(MD_ATTRIBUTE) && !html.includes(RAW_ATTRIBUTE)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(`[${MD_ATTRIBUTE}], [${RAW_ATTRIBUTE}]`).forEach((el) => {
    el.removeAttribute(MD_ATTRIBUTE);
    el.removeAttribute(RAW_ATTRIBUTE);
  });
  return doc.body.innerHTML;
}

/**
 * Paste never brings a kept source, a gap or a raw block: a page can hide
 * text in `data-md` that the editor would not show but the file would hold.
 * A pasted raw block opens as a code block.
 */
export const PastedMarkdownSource = Extension.create({
  name: 'pastedMarkdownSource',
  addProseMirrorPlugins() {
    return [new Plugin({ key: new PluginKey('pastedMarkdownSource'), props: { transformPastedHTML: stripMarkdownSource } })];
  },
});

/**
 * The `md` attribute on every block node. A block split at its end starts
 * without it (`keepOnSplit: false`); a split in the middle copies it, which
 * is safe: the copy no longer writes `norm`, and its `pair` no longer holds.
 */
export const MarkdownSource = Extension.create({
  name: 'markdownSource',
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          md: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => readMd(el),
            renderHTML: (attrs: Record<string, unknown>) => {
              const value = writeMd(attrs.md as MdBlock | null);
              return value ? { [MD_ATTRIBUTE]: value } : {};
            },
          },
        },
      },
    ];
  },
});
