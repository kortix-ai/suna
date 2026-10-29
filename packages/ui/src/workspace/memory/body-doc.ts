import type { JSONContent } from '@tiptap/core';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * A memory file's body as the reader's and editor's document, and back. The
 * same document draws the page and edits it, so reading and editing look the
 * same. Parsing is GFM (remark): headings, paragraphs, bold, italic, strike,
 * inline code, links, bullet, numbered, task and nested lists, quotes, code
 * blocks, tables, rules and line breaks; the ⟦n⟧ source tokens are a
 * `memorySource` node. Anything else (HTML, images, footnotes) stays as its
 * Markdown text.
 *
 * Canonical Markdown round-trips unchanged: blocks one blank line apart,
 * tight lists (`-`, `1.`, `- [ ]`), nested items indented to the marker,
 * `*italic*`, `~~strike~~`, `---` rules, ``` fences and `| --- |` tables.
 */

/** The mdast fields this file reads (remark's node shapes). */
interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  lang?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

type Mark = NonNullable<JSONContent['marks']>[number];

const TOKEN = /⟦(\d+)⟧/g;

/** A text run: ⟦n⟧ becomes a source node, a newline a soft break. */
function textNodes(value: string, marks: Mark[]): JSONContent[] {
  const out: JSONContent[] = [];
  const push = (text: string) => {
    text.split('\n').forEach((line, i) => {
      if (i > 0) out.push({ type: 'memorySoftBreak' });
      if (line) out.push(marks.length ? { type: 'text', text: line, marks } : { type: 'text', text: line });
    });
  };
  let at = 0;
  for (const match of value.matchAll(TOKEN)) {
    push(value.slice(at, match.index));
    out.push({ type: 'memorySource', attrs: { number: Number(match[1]) } });
    at = match.index + match[0].length;
  }
  push(value.slice(at));
  return out;
}

function raw(node: MdNode, source: string): string {
  const { start, end } = node.position ?? { start: {}, end: {} };
  return start.offset !== undefined && end.offset !== undefined ? source.slice(start.offset, end.offset) : (node.value ?? '');
}

function inlines(nodes: MdNode[] | undefined, source: string, marks: Mark[] = []): JSONContent[] {
  return (nodes ?? []).flatMap((node): JSONContent[] => {
    switch (node.type) {
      case 'text':
        return textNodes(node.value ?? '', marks);
      case 'inlineCode':
        return [{ type: 'text', text: node.value ?? '', marks: [...marks, { type: 'code' }] }];
      case 'strong':
        return inlines(node.children, source, [...marks, { type: 'bold' }]);
      case 'emphasis':
        return inlines(node.children, source, [...marks, { type: 'italic' }]);
      case 'delete':
        return inlines(node.children, source, [...marks, { type: 'strike' }]);
      case 'link':
        return inlines(node.children, source, [...marks, { type: 'link', attrs: { href: node.url ?? '' } }]);
      case 'break':
        return [{ type: 'hardBreak' }];
      default:
        return textNodes(raw(node, source), marks);
    }
  });
}

const withContent = (node: JSONContent, content: JSONContent[]): JSONContent =>
  content.length ? { ...node, content } : node;

function blocks(nodes: MdNode[] | undefined, source: string): JSONContent[] {
  return (nodes ?? []).map((node): JSONContent => {
    switch (node.type) {
      case 'paragraph':
        return withContent({ type: 'paragraph' }, inlines(node.children, source));
      case 'heading':
        return withContent({ type: 'heading', attrs: { level: node.depth ?? 1 } }, inlines(node.children, source));
      case 'thematicBreak':
        return { type: 'horizontalRule' };
      case 'blockquote':
        return { type: 'blockquote', content: blocks(node.children, source) };
      case 'code':
        return withContent({ type: 'codeBlock', attrs: { language: node.lang ?? null } }, node.value ? [{ type: 'text', text: node.value }] : []);
      case 'list': {
        const items = node.children ?? [];
        // A task list is one whose every item has a box; a box in a mixed list stays as its text.
        const task = items.every((item) => typeof item.checked === 'boolean');
        const content = items.map((item) => {
          const inner = blocks(item.children, source);
          const body: JSONContent[] = inner.length ? inner : [{ type: 'paragraph' }];
          if (task) return { type: 'taskItem', attrs: { checked: !!item.checked }, content: body };
          if (typeof item.checked === 'boolean' && body[0]?.type === 'paragraph') {
            body[0] = { ...body[0], content: [{ type: 'text', text: item.checked ? '[x] ' : '[ ] ' }, ...(body[0].content ?? [])] };
          }
          return { type: 'listItem', content: body };
        });
        if (task) return { type: 'taskList', content };
        return node.ordered
          ? { type: 'orderedList', attrs: { start: node.start ?? 1 }, content }
          : { type: 'bulletList', content };
      }
      case 'table':
        return {
          type: 'table',
          content: (node.children ?? []).map((row, r) => ({
            type: 'tableRow',
            content: (row.children ?? []).map((cell) => ({
              type: r === 0 ? 'tableHeader' : 'tableCell',
              content: [withContent({ type: 'paragraph' }, inlines(cell.children, source))],
            })),
          })),
        };
      default:
        return withContent({ type: 'paragraph' }, textNodes(raw(node, source), []));
    }
  });
}

export function markdownToDoc(markdown: string): JSONContent {
  const source = markdown.replace(/\r\n?/g, '\n');
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as unknown as MdNode;
  const content = blocks(tree.children, source);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Text that would read as Markdown is escaped; `_` only where it could open or close emphasis. */
function escapeText(text: string): string {
  return text.replace(/[\\*`[\]]|~~|(?<!\w)_|_(?!\w)/g, (m) => (m === '~~' ? '\\~\\~' : `\\${m}`));
}

const isUrl = (href: string) => /^https?:\/\/\S+$/.test(href);

function inlineMarkdown(nodes: JSONContent[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === 'memorySource') return `⟦${node.attrs?.number}⟧`;
      if (node.type === 'memorySoftBreak') return '\n';
      if (node.type === 'hardBreak') return '\\\n';
      const marks = new Map((node.marks ?? []).map((mark) => [mark.type, mark]));
      const plain = node.text ?? '';
      let text = marks.has('code') ? `\`${plain}\`` : escapeText(plain);
      const href = marks.get('link')?.attrs?.href as string | undefined;
      if (href !== undefined) text = href === plain && isUrl(href) && !marks.has('code') ? plain : `[${text}](${href})`;
      if (marks.has('italic')) text = `*${text}*`;
      if (marks.has('strike')) text = `~~${text}~~`;
      if (marks.has('bold')) text = `**${text}**`;
      return text;
    })
    .join('');
}

const indent = (text: string, by: string) => text.replace(/\n(?=.)/g, `\n${by}`);

function listMarkdown(node: JSONContent): string {
  return (node.content ?? [])
    .map((item, i) => {
      const marker =
        node.type === 'orderedList'
          ? `${Number(node.attrs?.start ?? 1) + i}. `
          : node.type === 'taskList'
            ? `- [${item.attrs?.checked ? 'x' : ' '}] `
            : '- ';
      // A nested list sits right under its item; other blocks a blank line apart.
      const parts = (item.content ?? []).map((child) => ({ list: /List$/.test(child.type ?? ''), text: blockMarkdown(child) }));
      const body = parts.reduce((acc, part, j) => (j === 0 ? part.text : `${acc}${part.list ? '\n' : '\n\n'}${part.text}`), '');
      return marker + indent(body, ' '.repeat(node.type === 'taskList' ? 2 : marker.length));
    })
    .join('\n');
}

function tableMarkdown(node: JSONContent): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? []).map((p) => inlineMarkdown(p.content)).join(' ').replace(/\n/g, ' ').replace(/\|/g, '\\|'),
    ),
  );
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(head.map(() => '---')), ...body.map(line)].join('\n');
}

function blockMarkdown(node: JSONContent): string {
  switch (node.type) {
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inlineMarkdown(node.content)}`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listMarkdown(node);
    case 'blockquote':
      return docToMarkdown(node)
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language ?? ''}\n${(node.content ?? []).map((c) => c.text ?? '').join('')}\n\`\`\``;
    case 'horizontalRule':
      return '---';
    case 'table':
      return tableMarkdown(node);
    default:
      return inlineMarkdown(node.content);
  }
}

/** The document as canonical Markdown; empty paragraphs drop out. */
export function docToMarkdown(doc: JSONContent): string {
  return (doc.content ?? [])
    .map(blockMarkdown)
    .filter((text) => text.trim())
    .join('\n\n');
}

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
/** 12 → "¹²": the font's own superscript figures, sized and set by the font. */
export function superscript(n: number): string {
  return String(n).replace(/\d/g, (digit) => SUPERSCRIPT[Number(digit)]!);
}

/**
 * A link in a memory file, as the reader opens it: an http(s) URL in a new
 * tab, a relative path (`profile.md`, `people/priya.md`, `../Notes.md`) as the
 * memory file it names, resolved against the open file's Drive path. Null
 * for anything else (an anchor, `mailto:`): the browser handles it.
 */
export function memoryLinkTarget(href: string, fromPath: string): { url: string } | { path: string } | null {
  if (isUrl(href)) return { url: href };
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return null;
  const dir = fromPath.slice(0, fromPath.lastIndexOf('/') + 1) || '/';
  const resolved = new URL(href.split('#')[0]!, `file://${dir}`).pathname;
  return { path: decodeURIComponent(resolved) };
}
