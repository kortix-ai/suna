import { type Extensions, Node, type NodeViewRenderer } from '@tiptap/core';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';

import { superscript } from './body-doc';

/** The body's type, on the V1 scale: one set of classes draws the page and edits it. */
export const BODY_CLASS = {
  root: 'flex flex-col gap-4 outline-none',
  paragraph: 'text-base leading-relaxed text-pretty',
  heading: 'text-base font-semibold',
  bulletList: 'marker:text-muted-foreground flex list-disc flex-col gap-2 pl-5',
  orderedList: 'marker:text-muted-foreground flex list-decimal flex-col gap-2 pl-5',
  listItem: 'text-base leading-relaxed [&>ol]:mt-2 [&>ul]:mt-2',
  taskList: 'flex flex-col gap-2',
  taskItem:
    'flex items-start gap-2 text-base leading-relaxed [&_input]:accent-foreground [&>label]:mt-1.5 [&>label]:flex [&>label]:shrink-0 [&>div]:min-w-0 [&>div]:flex-1',
  blockquote: 'text-muted-foreground flex flex-col gap-4 border-l-2 pl-4',
  codeBlock: 'bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs',
  horizontalRule: 'border-border my-2',
  table: 'w-full border-collapse text-sm',
  tableCell: 'border-border border px-3 py-1.5 text-left align-top',
  tableHeader: 'border-border border px-3 py-1.5 text-left align-top font-semibold',
  code: 'bg-muted rounded-sm px-1 font-mono',
  bold: 'font-semibold',
  italic: 'italic',
  strike: 'line-through',
  link: 'underline underline-offset-2 cursor-pointer',
  /** `SourceMark`'s classes, without its hover. */
  source: 'text-foreground -mx-0.5 -my-1 rounded-sm px-0.5 py-1',
} as const;

interface MemorySourceOptions {
  /** The page's source numbers; a number outside it draws nothing and is kept. Null draws every number. */
  known: ReadonlySet<number> | null;
  /** The host's view of a number (the reader's `SourceMark`); absent, a plain superscript. */
  view: NodeViewRenderer | null;
}

/**
 * ⟦n⟧: the source number, a superscript that the caret steps over and
 * Backspace deletes whole.
 */
const MemorySource = Node.create<MemorySourceOptions>({
  name: 'memorySource',
  addOptions: () => ({ known: null, view: null }),
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ number: { default: 1 } }),
  parseHTML: () => [{ tag: 'span[data-memory-source]' }],
  renderHTML({ node }) {
    const number = Number(node.attrs.number);
    const shown = !this.options.known || this.options.known.has(number);
    return [
      'span',
      { 'data-memory-source': number, contenteditable: 'false', class: shown ? BODY_CLASS.source : 'hidden' },
      shown ? superscript(number) : '',
    ];
  },
  addNodeView() {
    return this.options.view;
  },
  renderText: ({ node }) => `⟦${node.attrs.number}⟧`,
});

/** A line break inside a paragraph's Markdown: drawn as the space Markdown makes of it. */
const MemorySoftBreak = Node.create({
  name: 'memorySoftBreak',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  parseHTML: () => [{ tag: 'span[data-memory-soft-break]' }],
  renderHTML: () => ['span', { 'data-memory-soft-break': '' }, ' '],
  renderText: () => ' ',
});

/**
 * The memory body's schema: the GFM subset `body-doc.ts` reads and writes,
 * with its Markdown shortcuts (`## `, `- `, `1. `, `[ ] `, `> `, `**bold**`,
 * `*italic*`, `` `code` ``, ``` fences, `---`). No toolbar.
 */
export function memoryBodyExtensions(options: Partial<MemorySourceOptions> = {}): Extensions {
  const attrs = (name: keyof typeof BODY_CLASS) => ({ HTMLAttributes: { class: BODY_CLASS[name] } });
  return [
    StarterKit.configure({
      underline: false,
      trailingNode: false,
      paragraph: attrs('paragraph'),
      heading: attrs('heading'),
      bulletList: attrs('bulletList'),
      orderedList: attrs('orderedList'),
      listItem: attrs('listItem'),
      blockquote: attrs('blockquote'),
      codeBlock: attrs('codeBlock'),
      horizontalRule: attrs('horizontalRule'),
      code: attrs('code'),
      bold: attrs('bold'),
      italic: attrs('italic'),
      strike: attrs('strike'),
      link: { openOnClick: false, autolink: false, HTMLAttributes: { class: BODY_CLASS.link, rel: null, target: null } },
    }),
    TaskList.configure(attrs('taskList')),
    TaskItem.configure({ nested: true, ...attrs('taskItem') }),
    TableKit.configure({
      table: { resizable: false, HTMLAttributes: { class: BODY_CLASS.table } },
      tableCell: attrs('tableCell'),
      tableHeader: attrs('tableHeader'),
    }),
    MemorySource.configure({ known: options.known ?? null, view: options.view ?? null }),
    MemorySoftBreak,
  ];
}
