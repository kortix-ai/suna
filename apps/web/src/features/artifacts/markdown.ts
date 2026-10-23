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
    .replace(/<li><input (checked="" )?disabled="" type="checkbox">\s*/g, (_m, checked) => `<li data-type="taskItem" data-checked="${checked ? 'true' : 'false'}">`)
    .replace(/<ul>(\s*<li data-type="taskItem")/g, '<ul data-type="taskList">$1');
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
  td.remove(['label']);
  service = td;
  return td;
}

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // A table cell holds one line in Markdown: unwrap the editor's paragraphs.
  doc.querySelectorAll('td > p, th > p').forEach((p) => p.replaceWith(...Array.from(p.childNodes)));
  doc.querySelectorAll('colgroup').forEach((c) => c.remove());
  return `${turndown().turndown(doc.body.innerHTML).trim()}\n`;
}
