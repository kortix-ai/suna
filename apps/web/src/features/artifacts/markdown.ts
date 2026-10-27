import { marked } from 'marked';
import TurndownService from 'turndown';
import { strikethrough, tables } from 'turndown-plugin-gfm';

/**
 * A doc artifact is a Markdown file in Files. The editor works in HTML, so a
 * doc goes Markdown → HTML on load and HTML → Markdown on save. GFM tables,
 * strikethrough and task lists survive the round trip.
 */
export function markdownToHtml(markdown: string): string {
  return (marked.parse(markdown, { gfm: true, async: false }) as string)
    // marked's task items → the editor's (`li[data-type=taskItem]`).
    // A loose list (blank lines between items) puts the box inside a <p>: keep the <p> as the item's text.
    .replace(/<li>(<p>)?<input (checked="" )?disabled="" type="checkbox">\s*/g, (_m, p, checked) => `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}">${p ?? ''}`)
    .replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1')
    // marked keeps a fence's last newline; the editor would show it as an empty line.
    .replace(/\n<\/code><\/pre>/g, '</code></pre>');
}

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
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
  return `${turndown().turndown(doc.body.innerHTML).trim()}\n`;
}
