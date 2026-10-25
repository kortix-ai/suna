import { Marked } from 'marked';
import TurndownService from 'turndown';
import { strikethrough, tables } from 'turndown-plugin-gfm';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Raw HTML in the Markdown shows as the text it is (`<package>` in a
 * sentence), so the editor keeps it and saves it back. The editor has no
 * node for an unknown tag and would drop it. A `<video>` is the one tag a
 * doc holds as HTML.
 */
const parser = new Marked({
  renderer: {
    html: ({ text }) => (/^<\/?video\b/i.test(text.trim()) ? text : escapeHtml(text)),
  },
});

/**
 * The document editor holds Markdown files (a doc artifact, an agent's
 * instructions). The editor works in HTML, so a doc goes Markdown → HTML on
 * load and HTML → Markdown on save. GFM tables, strikethrough and task lists
 * survive the round trip, and so do the file's own line breaks: a source
 * line break inside a paragraph (a soft break) becomes
 * `<span data-soft-break>`, which reads as a space and saves as a newline.
 * A file wrapped at 72 columns stays wrapped, so a one-word edit is a
 * one-line diff.
 */
export function markdownToHtml(markdown: string): string {
  const html = (parser.parse(markdown, { gfm: true, async: false }) as string)
    // marked's task items → the editor's (`li[data-type=taskItem]`).
    // A loose list (blank lines between items) puts the box inside a <p>: keep the <p> as the item's text.
    .replace(/<li>(<p>)?<input (checked="" )?disabled="" type="checkbox">\s*/g, (_m, p, checked) => `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}">${p ?? ''}`)
    .replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1')
    // marked keeps a fence's last newline; the editor would show it as an empty line.
    .replace(/\n<\/code><\/pre>/g, '</code></pre>');
  return markSoftBreaks(html);
}

const TEXT_BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th';
const BLOCK_TAGS = new Set(['UL', 'OL', 'P', 'PRE', 'BLOCKQUOTE', 'TABLE', 'DIV', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const CONTAINER_TAGS = new Set([...BLOCK_TAGS, 'LI', 'THEAD', 'TBODY', 'TR']);

/** Each newline inside a text block's text → `<span data-soft-break> </span>`. */
function markSoftBreaks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
  for (const text of texts) {
    const parent = text.parentElement;
    if (!parent || !text.data.includes('\n') || parent.closest('pre, code')) continue;
    const block = parent.closest(TEXT_BLOCK);
    // Only text that flows in the block: not the newlines between a nested list's items.
    if (!block || (parent !== block && CONTAINER_TAGS.has(parent.nodeName))) continue;
    // A newline beside a block edge (before a nested list, at the item's end) is layout, not a break.
    const edge = (sibling: ChildNode | null) => (sibling ? BLOCK_TAGS.has(sibling.nodeName) : parent === block);
    let data = text.data;
    if (edge(text.nextSibling)) data = data.replace(/\n+$/, '');
    if (edge(text.previousSibling)) data = data.replace(/^\n+/, '');
    const pieces: Node[] = [];
    data.split('\n').forEach((part, i) => {
      if (i > 0) {
        const soft = doc.createElement('span');
        soft.setAttribute('data-soft-break', '');
        soft.textContent = ' ';
        pieces.push(soft);
      }
      if (part) pieces.push(doc.createTextNode(part));
    });
    text.replaceWith(...pieces);
  }
  return doc.body.innerHTML;
}

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    // A soft break holds only a space, so turndown sees it as blank: it saves as the newline it was.
    blankReplacement: (_content, node) =>
      node.nodeName === 'SPAN' && (node as HTMLElement).hasAttribute('data-soft-break')
        ? '\n'
        : (node as { isBlock?: boolean }).isBlock
          ? '\n\n'
          : '',
  });
  tables(td);
  strikethrough(td);
  td.addRule('taskItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => `- [${(node as HTMLElement).getAttribute('data-checked') === 'true' ? 'x' : ' '}] ${content.trim().replace(/\n+/g, ' ')}\n`,
  });
  // Tight items (`- a`, `1. a`), nested lines indented to the marker's width.
  // Added after taskItem, so it would win (turndown tries later rules first): skip task items.
  td.addRule('listItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') !== 'taskItem',
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null;
      const index = parent ? Array.prototype.indexOf.call(parent.children, node) : 0;
      const start = Number(parent?.getAttribute('start') ?? 1);
      const prefix = parent?.nodeName === 'OL' ? `${start + index}. ` : '- ';
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '').replace(/\n/g, `\n${' '.repeat(prefix.length)}`);
      return `${prefix}${body}\n`;
    },
  });
  // An underscore inside a word (`feature_disabled`) never starts emphasis: keep it bare.
  const escape = td.escape.bind(td);
  td.escape = (text: string) => escape(text).replace(/(\w)\\_(?=\w)/g, '$1_');
  td.remove(['label']);
  // A video stays an HTML tag inside the Markdown: Markdown has none.
  td.keep(['video']);
  service = td;
  return td;
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // A table cell holds one line in Markdown: unwrap the editor's paragraphs.
  doc.querySelectorAll('td > p, th > p').forEach((p) => p.replaceWith(...Array.from(p.childNodes)));
  // A list item with one paragraph is one line: unwrap it, so the list stays tight.
  doc.querySelectorAll('li > p:only-of-type').forEach((p) => p.replaceWith(...Array.from(p.childNodes)));
  doc.querySelectorAll('colgroup').forEach((c) => c.remove());
  // Empty, so turndown adds no flanking space: the soft break saves as a bare newline.
  doc.querySelectorAll('span[data-soft-break]').forEach((s) => {
    s.textContent = '';
  });
  return `${turndown().turndown(doc.body.innerHTML).trim()}\n`;
}
